import { Inject, OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { Server, Socket } from 'socket.io';
import { QueryBus, IQuery, setQueryMetadata } from '@easylayer/common/cqrs';
import { IncomingMessage, DefaultIncomingActions } from '../interfaces';
import { WsProducer, WsOutgoingActions } from './ws.producer';

// This is WS Consumer

type WsIncomingActions = DefaultIncomingActions;

export interface WsPayload {
  constructorName: string;
  dto: any;
}

export interface WsIncomingMessage extends IncomingMessage<WsIncomingActions, WsPayload> {}

@WebSocketGateway({
  cors: { credentials: false, origin: '*' },
  path: '/',
})
export class WsGateway implements OnModuleDestroy {
  @WebSocketServer()
  private _server!: Server;
  private _timer: ExponentialTimer | null = null;

  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
    private readonly producer: WsProducer,
    private readonly log: AppLogger
  ) {
    // IMPORTANT: Ping sends constantly and regardless.
    this.log.debug('Starting ping to clients via WS');
    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.producer.sendPing(this._server);
        } catch (error) {
          resetInterval();
        }
      },
      {
        interval: 500,
        maxInterval: 3000,
        multiplier: 2,
      }
    );
  }

  get server() {
    return this._server;
  }

  onModuleDestroy() {
    this._timer?.destroy();
    this._timer = null;
    this.log.debug('Ws closing server');
    this.server?.close();
  }

  @SubscribeMessage('message')
  async handleMessage(@MessageBody() raw: unknown, @ConnectedSocket() client: Socket): Promise<void> {
    this.log.debug('Received raw Ws message', { args: { raw } });
    const msg = raw as IncomingMessage<DefaultIncomingActions, WsPayload>;
    const { action, requestId, payload } = msg;

    this.log.debug('Parsed WS message', { args: { action, requestId, payload } });

    if (!action) {
      this.log.debug('No action provided, ignoring message');
      return;
    }

    if (action === 'pong') {
      this.producer.markPong();
      return;
    }

    if (!this.producer.isConnected()) {
      this.log.debug('Connection not alive, ignoring message');
      // IMPORTANT: We do not process incoming messages
      // until a connection is established.
      return;
    }

    let responseAction: WsOutgoingActions;
    let responsePayload: any = {};

    try {
      if (action === 'query' && payload) {
        this.log.debug('Executing query', { args: { constructorName: payload.constructorName, dto: payload.dto } });
        responsePayload = await this.executeQuery(payload);
        responseAction = 'queryResponse';
        this.log.debug('Query executed, preparing response', { args: { responsePayload } });
      } else {
        this.log.debug('Unsupported action, ignoring', { args: { action } });
        return;
      }
    } catch (err: any) {
      responseAction = 'error';
      responsePayload = { error: err.message || String(err) };
      this.log.debug('Error during query execution', { methodName: 'handleMessage', args: { error: err } });
    }

    this.log.debug('Sending response message', { args: { responseAction, requestId, responsePayload } });
    await this.producer.sendMessage({ action: responseAction, payload: responsePayload, requestId }, this.server);
  }

  /**
   * Dynamically construct and execute a CQRS query.
   */
  private async executeQuery({ constructorName, dto = {} }: { constructorName: string; dto: any }) {
    const Query = class {};
    Object.defineProperty(Query, 'name', { value: constructorName });

    setQueryMetadata(Query);

    const instance = Object.assign(Object.create(Query.prototype), { payload: dto }) as IQuery;
    return await this.queryBus.execute(instance);
  }
}
