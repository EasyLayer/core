import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseConsumer } from '../../core';
import {
  IncomingMessage,
  BasePayload,
  MESSAGE_SIZE_LIMITS,
  validateMessageSize,
  BadRequestError,
  OutgoingMessage,
  OutboxStreamAckPayload,
} from '../../shared';
import { IpcChildProducer } from './ipc-child.producer';
import type { IpcServerOptions } from './ipc-child.module';

/**
 * IPC Consumer responsibilities (all inbound):
 * - Subscribe to `process.on('message')`.
 * - For 'pong': call producer.markPong() → producer becomes "connected".
 * - For 'secureHello': call producer.buildSecureReplyForHello() and immediately send reply.
 * - For 'secureAck': call producer.finalizeSecure().
 * - For 'outboxStreamAck': call producer.resolveOutboxAck(batchId, result) to complete the waiting sender.
 * - For queries: validate, execute via QueryBus, and respond via producer.sendMessage().
 *
 * Producer never listens to inbound frames; Consumer never sends directly (always via producer).
 */
@Injectable()
export class IpcChildConsumer extends BaseConsumer implements OnModuleDestroy {
  private readonly maxMessageSize: number;

  constructor(
    @Inject(QueryBus) private readonly queryBus: QueryBus,
    @Inject('IPC_PRODUCER')
    private readonly producer: IpcChildProducer,
    private readonly log: AppLogger,
    @Inject('IPC_OPTIONS') private readonly options: IpcServerOptions
  ) {
    super();

    if (!process.send) throw new Error('IpcConsumer must run in a child process with IPC');

    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.IPC;

    process.on('message', this.handleMessage);
  }

  public async onModuleDestroy(): Promise<void> {
    process.removeListener('message', this.handleMessage);
  }

  // Bind to keep same reference for removeListener
  private handleMessage = async (raw: unknown) => {
    try {
      // Guard malformed
      if (!raw || typeof raw !== 'object') return;
      validateMessageSize(raw, this.maxMessageSize, 'ipc');

      const msg = raw as IncomingMessage;
      const { action, requestId } = msg;
      if (!action) return;

      // 1) Heartbeat
      if (action === 'pong') {
        this.producer.markPong();
        return;
      }

      // 2) Secure handshake (server side)
      if (action === 'secureHello') {
        const reply = this.producer.buildSecureReplyForHello((msg as any).payload);
        await this.producer.sendMessage(reply);
        return;
      }
      if (action === 'secureAck') {
        this.producer.finalizeSecure((msg as any).payload);
        return;
      }

      // 3) Outbox ACK
      if (action === 'outboxStreamAck') {
        const payload = msg.payload as OutboxStreamAckPayload | undefined;
        if (payload?.batchId) {
          this.producer.resolveOutboxAck(payload.batchId, {
            allOk: !!payload.allOk,
            okIndices: payload.okIndices,
          });
        }
        return;
      }

      // 4) RPC: ignore until we have a pong (producer decides readiness)
      if (!this.producer.isConnected()) return;

      // 5) Queries
      if (action === 'query') {
        await this.handleQuery(msg as IncomingMessage<'query', BasePayload>);
        return;
      }
      if (action === 'streamQuery') {
        await this.handleStreamQuery(msg as IncomingMessage<'streamQuery', BasePayload>);
        return;
      }

      // Everything else is ignored on purpose to keep hot path minimal.
    } catch (err: any) {
      // Best-effort error response (do not crash consumer loop).
      try {
        const errorResponse = this.createErrorResponse(err, (raw as any)?.requestId);
        await this.producer.sendMessage(errorResponse);
      } catch {
        /* swallow */
      }
    }
  };

  private async handleQuery(msg: IncomingMessage<'query', BasePayload>): Promise<void> {
    const { requestId, payload } = msg;
    try {
      if (!this.validateQueryPayload(payload)) throw new BadRequestError('Missing or invalid payload for query');
      const result = await this.executeQuery(this.queryBus, payload);
      const response = this.createResponse('queryResponse', result, requestId);
      await this.producer.sendMessage(response);
    } catch (err: any) {
      const errorResponse = this.createErrorResponse(err, requestId);
      await this.producer.sendMessage(errorResponse);
    }
  }

  private async handleStreamQuery(msg: IncomingMessage<'streamQuery', BasePayload>): Promise<void> {
    const { requestId, payload } = msg;
    try {
      if (!this.validateQueryPayload(payload)) throw new BadRequestError('Missing or invalid payload for streamQuery');
      const stream = this.handleStreamingQuery(this.queryBus, payload);
      for await (const response of stream) {
        const withId: OutgoingMessage = { ...response, requestId };
        await this.producer.sendMessage(withId);
      }
      const endMessage = this.createResponse('streamEnd', undefined, requestId);
      await this.producer.sendMessage(endMessage);
    } catch (err: any) {
      const errorResponse = this.createErrorResponse(err, requestId);
      await this.producer.sendMessage(errorResponse);
    }
  }
}
