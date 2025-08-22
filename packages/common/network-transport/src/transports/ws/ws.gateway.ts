import { Injectable, Inject } from '@nestjs/common';
import { Socket, Server } from 'socket.io';
import { QueryBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseConsumer } from '../../core';
import {
  BasePayload,
  BadRequestError,
  MESSAGE_SIZE_LIMITS,
  validateMessageSize,
  IncomingMessage,
  OutgoingMessage,
  OutboxStreamAckPayload,
} from '../../shared';
import { WsProducer } from './ws.producer';
import type { WsServerOptions } from './ws.module';

/**
 * WS Gateway acts as Consumer:
 * - Receives inbound socket messages.
 * - For 'pong': mark producer as alive.
 * - For 'outboxStreamAck': resolve waiting batch in producer.
 * - For 'query'/'streamQuery': execute via QueryBus and respond through producer.
 * - Keeps 'streamQuery' optional (flag in options).
 */
@Injectable()
export class WsGateway extends BaseConsumer {
  private _server!: Server; // set by a server manager
  private readonly maxMessageSize: number;

  constructor(
    @Inject(QueryBus) private readonly queryBus: QueryBus,
    @Inject('WS_PRODUCER')
    private readonly producer: WsProducer,
    private readonly log: AppLogger,
    @Inject('WS_OPTIONS') private readonly wsOptions: WsServerOptions
  ) {
    super();
    this.maxMessageSize = wsOptions.maxMessageSize ?? MESSAGE_SIZE_LIMITS.WS;
  }

  get server(): Server {
    return this._server;
  }
  setServer(server: Server) {
    this._server = server;
  }

  async handleMessage(raw: unknown, client: Socket): Promise<void> {
    try {
      validateMessageSize(raw, this.maxMessageSize, 'ws');
      if (!this.validateMessage(raw)) {
        await this.sendErrorToClient(client, new BadRequestError('Invalid message format'), undefined);
        return;
      }

      const msg = raw as IncomingMessage;
      const { action, requestId } = msg;

      // Heartbeat: mark alive
      if (action === 'pong') {
        this.producer.markPong();
        return;
      }

      // ACK for outbox stream
      if (action === 'outboxStreamAck') {
        const payload = msg.payload as OutboxStreamAckPayload;
        if (payload?.batchId)
          this.producer.resolveOutboxAck(payload.batchId, {
            allOk: !!payload.allOk,
            okIndices: payload.okIndices,
          });
        return;
      }

      // Before serving RPC, ensure producer is considered connected
      if (!this.producer.isConnected()) return;

      if (action === 'query') {
        await this.handleQuery(client, msg as IncomingMessage<'query', BasePayload>);
      } else if (action === 'streamQuery') {
        await this.handleStreamQuery(client, msg as IncomingMessage<'streamQuery', BasePayload>);
      } else {
        await this.sendErrorToClient(client, new BadRequestError(`Unsupported action: ${action}`), requestId);
      }
    } catch (err: any) {
      await this.sendErrorToClient(client, err, undefined);
    }
  }

  private async handleQuery(client: Socket, msg: IncomingMessage<'query', BasePayload>): Promise<void> {
    const { requestId, payload } = msg;
    try {
      if (!this.validateQueryPayload(payload)) throw new BadRequestError('Missing or invalid payload for query');
      const result = await this.executeQuery(this.queryBus, payload);
      const response = this.createResponse('queryResponse', result, requestId);
      await this.producer.sendMessage(response, this.server);
    } catch (err: any) {
      await this.sendErrorToClient(client, err, requestId);
    }
  }

  private async handleStreamQuery(client: Socket, msg: IncomingMessage<'streamQuery', BasePayload>): Promise<void> {
    const { requestId, payload } = msg;
    try {
      if (!this.validateQueryPayload(payload)) throw new BadRequestError('Missing or invalid payload for streamQuery');
      const gen = this.handleStreamingQuery(this.queryBus, payload);
      for await (const response of gen) {
        const withId: OutgoingMessage = { ...response, requestId };
        await this.producer.sendMessage(withId, this.server);
      }
      const endMessage = this.createResponse('streamEnd', undefined, requestId);
      await this.producer.sendMessage(endMessage, this.server);
    } catch (err: any) {
      await this.sendErrorToClient(client, err, requestId);
    }
  }

  private async sendErrorToClient(client: Socket, error: any, requestId?: string): Promise<void> {
    try {
      const errorResponse = this.createErrorResponse(error, requestId);
      await this.producer.sendMessage(errorResponse, this.server);
    } catch {
      /* ignore */
    }
  }
}
