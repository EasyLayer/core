import { Inject, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { QueryBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseConsumer } from '../../core/base-consumer';
import { BasePayload, BadRequestError, MESSAGE_SIZE_LIMITS, validateMessageSize } from '../../shared';
import type { IncomingMessage } from '../../shared';
import { WsProducer } from './ws.producer';
import type { WsServerOptions } from './ws.module';

@WebSocketGateway()
export class WsGateway extends BaseConsumer implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  private _server!: Server;

  private readonly maxMessageSize: number;

  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
    private readonly producer: WsProducer,
    private readonly log: AppLogger,
    @Inject('WS_OPTIONS')
    private readonly options: WsServerOptions
  ) {
    super();
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.WS;
  }

  get server() {
    return this._server;
  }

  onModuleInit() {
    // Set server reference in producer
    this.producer.setServer(this._server);
    this.log.info(`WebSocket gateway initialized: port=${this.options.port}, path=${this.options.path}`);
  }

  onModuleDestroy() {
    this.log.debug('WebSocket gateway closing server');
    this.server?.close();
  }

  @SubscribeMessage('message')
  async handleMessage(@MessageBody() raw: unknown, @ConnectedSocket() client: Socket): Promise<void> {
    this.log.debug('Received raw WebSocket message', {
      args: { clientId: client.id, hasData: !!raw },
    });

    try {
      // Validate message size
      validateMessageSize(raw, this.maxMessageSize, 'ws', this.options.name || 'ws');

      if (!this.validateMessage(raw)) {
        this.log.debug('Invalid WebSocket message format, ignoring');
        await this.sendErrorToClient(client, new BadRequestError('Invalid message format'), undefined);
        return;
      }

      const msg = raw as IncomingMessage<'query' | 'streamQuery' | 'pong', BasePayload>;
      const { action, requestId, payload } = msg;

      this.log.debug('Parsed WebSocket message', {
        args: { action, requestId, clientId: client.id },
      });

      if (action === 'pong') {
        this.producer.markPong();
        return;
      }

      if (!this.producer.isConnected()) {
        this.log.debug('WebSocket connection not alive, ignoring message');
        return;
      }

      if (action === 'query') {
        await this.handleQuery(client, msg as IncomingMessage<'query', BasePayload>);
      } else if (action === 'streamQuery') {
        await this.handleStreamQuery(client, msg as IncomingMessage<'streamQuery', BasePayload>);
      } else {
        this.log.debug('Unsupported WebSocket action, ignoring', { args: { action } });
        await this.sendErrorToClient(client, new BadRequestError(`Unsupported action: ${action}`), requestId);
      }
    } catch (err: any) {
      this.log.error('Error processing WebSocket message', {
        args: { error: err.message, clientId: client.id, stack: err.stack },
      });

      await this.sendErrorToClient(client, err, undefined);
    }
  }

  private async handleQuery(client: Socket, msg: IncomingMessage<'query', BasePayload>): Promise<void> {
    const { requestId, payload } = msg;

    try {
      if (!this.validateQueryPayload(payload)) {
        throw new BadRequestError('Missing or invalid payload for query');
      }

      this.log.debug('Executing WebSocket query', {
        args: {
          constructorName: payload.constructorName,
          clientId: client.id,
          requestId,
        },
      });

      const result = await this.executeQuery(this.queryBus, payload);

      this.log.debug('WebSocket query executed, preparing response', {
        args: { clientId: client.id, requestId },
      });

      const response = this.createResponse('queryResponse', result, requestId);
      await this.producer.sendMessage(response, this.server);
    } catch (err: any) {
      this.log.error('Error during WebSocket query execution', {
        args: {
          error: err.message,
          clientId: client.id,
          requestId,
          stack: err.stack,
        },
      });

      await this.sendErrorToClient(client, err, requestId);
    }
  }

  private async handleStreamQuery(client: Socket, msg: IncomingMessage<'streamQuery', BasePayload>): Promise<void> {
    const { requestId, payload } = msg;

    try {
      if (!this.validateQueryPayload(payload)) {
        throw new BadRequestError('Missing or invalid payload for streamQuery');
      }

      this.log.debug('Executing WebSocket stream query', {
        args: {
          constructorName: payload.constructorName,
          clientId: client.id,
          requestId,
        },
      });

      const streamGenerator = this.handleStreamingQuery(this.queryBus, payload);

      for await (const responseMessage of streamGenerator) {
        const responseWithId = { ...responseMessage, requestId };
        await this.producer.sendMessage(responseWithId, this.server);
      }

      const endMessage = this.createResponse('streamEnd', undefined, requestId);
      await this.producer.sendMessage(endMessage, this.server);
    } catch (err: any) {
      this.log.error('Error during WebSocket stream query execution', {
        args: {
          error: err.message,
          clientId: client.id,
          requestId,
          stack: err.stack,
        },
      });

      await this.sendErrorToClient(client, err, requestId);
    }
  }

  private async sendErrorToClient(client: Socket, error: any, requestId?: string): Promise<void> {
    try {
      const errorResponse = this.createErrorResponse(error, requestId);
      await this.producer.sendMessage(errorResponse, this.server);
    } catch (sendError: any) {
      this.log.error('Failed to send error response to WebSocket client', {
        args: {
          originalError: error.message,
          sendError: sendError.message,
          clientId: client.id,
        },
      });
    }
  }
}
