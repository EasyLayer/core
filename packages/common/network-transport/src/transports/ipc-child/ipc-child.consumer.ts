import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseConsumer } from '../../core/base-consumer';
import { IncomingMessage, BasePayload, BadRequestError, MESSAGE_SIZE_LIMITS, validateMessageSize } from '../../shared';
import { IpcChildProducer } from './ipc-child.producer';
import type { IpcServerOptions } from './ipc-child.module';

export interface IpcIncomingMessage extends IncomingMessage<'query' | 'streamQuery' | 'pong', BasePayload> {
  correlationId: string;
}

@Injectable()
export class IpcChildConsumer extends BaseConsumer implements OnModuleDestroy {
  private readonly maxMessageSize: number;

  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
    private readonly producer: IpcChildProducer,
    private readonly log: AppLogger,
    @Inject('IPC_OPTIONS')
    private readonly options: IpcServerOptions
  ) {
    super();

    if (!process.send) {
      throw new Error('IpcConsumer must run in a child process with IPC');
    }

    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.IPC;
    process.on('message', this.handleMessage.bind(this));

    this.log.info('IPC consumer initialized and listening for messages', {
      args: {
        pid: process.pid,
        maxMessageSize: this.maxMessageSize,
        heartbeatTimeout: options.heartbeatTimeout || 10000,
      },
    });
  }

  public async onModuleDestroy(): Promise<void> {
    process.removeListener('message', this.handleMessage.bind(this));
    this.log.debug('IPC consumer destroyed');
  }

  private async handleMessage(raw: unknown) {
    this.log.debug('Received raw IPC message', {
      args: {
        hasData: !!raw,
        pid: process.pid,
        connected: process.connected,
      },
    });

    try {
      // Guard: Skip everything that doesn't look like a message
      if (!raw || typeof raw !== 'object') {
        this.log.debug('Invalid IPC message type, ignoring');
        return;
      }

      // Validate message size
      validateMessageSize(raw, this.maxMessageSize, 'ipc');

      const msg = raw as IpcIncomingMessage;
      const { correlationId, action, requestId } = msg;

      this.log.debug('Parsed IPC message', {
        args: {
          action,
          requestId,
          correlationId,
          pid: process.pid,
        },
      });

      if (typeof correlationId !== 'string' || !action) {
        this.log.debug('No action or correlationId provided, ignoring IPC message');
        return;
      }

      // Handle pong messages
      if (action === 'pong') {
        this.producer.markPong();
        return;
      }

      // Check if producer is connected
      if (!this.producer.isConnected()) {
        this.log.debug('IPC connection not alive, ignoring message');
        return;
      }

      // Handle query messages
      if (action === 'query') {
        await this.handleQuery(msg);
      } else if (action === 'streamQuery') {
        await this.handleStreamQuery(msg);
      } else {
        this.log.debug('Unsupported IPC action, ignoring', { args: { action } });
        const errorResponse = this.createErrorResponse(new BadRequestError(`Unsupported action: ${action}`), requestId);
        await this.producer.sendMessage(errorResponse, { correlationId });
      }
    } catch (err: any) {
      this.log.error('Error processing IPC message', {
        args: {
          error: err.message,
          stack: err.stack,
          pid: process.pid,
          connected: process.connected,
        },
      });

      try {
        const errorResponse = this.createErrorResponse(err, undefined);
        await this.producer.sendMessage(errorResponse, { correlationId: 'error' });
      } catch (sendError: any) {
        this.log.error('Failed to send IPC error response', {
          args: {
            originalError: err.message,
            sendError: sendError.message,
            pid: process.pid,
          },
        });
      }
    }
  }

  private async handleQuery(msg: IpcIncomingMessage): Promise<void> {
    const { correlationId, requestId, payload } = msg;

    try {
      if (!this.validateQueryPayload(payload)) {
        throw new BadRequestError('Missing or invalid payload for query');
      }

      this.log.debug('Executing IPC query', {
        args: {
          constructorName: payload.constructorName,
          correlationId,
          requestId,
          pid: process.pid,
        },
      });

      const result = await this.executeQuery(this.queryBus, payload);

      this.log.debug('IPC query executed, preparing response', {
        args: { correlationId, requestId, pid: process.pid },
      });

      const response = this.createResponse('queryResponse', result, requestId);
      await this.producer.sendMessage(response, { correlationId });
    } catch (err: any) {
      this.log.error('Error during IPC query execution', {
        args: {
          error: err.message,
          correlationId,
          requestId,
          stack: err.stack,
          pid: process.pid,
        },
      });

      const errorResponse = this.createErrorResponse(err, requestId);
      await this.producer.sendMessage(errorResponse, { correlationId });
    }
  }

  private async handleStreamQuery(msg: IpcIncomingMessage): Promise<void> {
    const { correlationId, requestId, payload } = msg;

    try {
      if (!this.validateQueryPayload(payload)) {
        throw new BadRequestError('Missing or invalid payload for streamQuery');
      }

      this.log.debug('Executing IPC stream query', {
        args: {
          constructorName: payload.constructorName,
          correlationId,
          requestId,
          pid: process.pid,
        },
      });

      const streamGenerator = this.handleStreamingQuery(this.queryBus, payload);

      for await (const responseMessage of streamGenerator) {
        const responseWithId = { ...responseMessage, requestId };
        await this.producer.sendMessage(responseWithId, { correlationId });
      }

      const endMessage = this.createResponse('streamEnd', undefined, requestId);
      await this.producer.sendMessage(endMessage, { correlationId });
    } catch (err: any) {
      this.log.error('Error during IPC stream query execution', {
        args: {
          error: err.message,
          correlationId,
          requestId,
          stack: err.stack,
          pid: process.pid,
        },
      });

      const errorResponse = this.createErrorResponse(err, requestId);
      await this.producer.sendMessage(errorResponse, { correlationId });
    }
  }
}
