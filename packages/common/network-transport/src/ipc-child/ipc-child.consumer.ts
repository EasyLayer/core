import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { QueryBus, IQuery, setQueryMetadata } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { IpcChildProducer, IpcOutgoingActions } from './ipc-child.producer';
import { IncomingMessage, DefaultIncomingActions } from '../interfaces';

type IpcIncomingActions = DefaultIncomingActions;

export interface IpcPayload {
  constructorName: string;
  dto: any;
}

export interface IpcIncomingMessage extends IncomingMessage<IpcIncomingActions, IpcPayload> {
  correlationId: string;
}

@Injectable()
export class IpcChildConsumer implements OnModuleDestroy {
  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
    private readonly producer: IpcChildProducer,
    private readonly log: AppLogger
  ) {
    if (!process.send) {
      throw new Error('IpcChildConsumer must run in a child process with IPC');
    }

    process.on('message', this.handleMessage.bind(this));
  }

  public async onModuleDestroy(): Promise<void> {
    process.removeListener('message', this.handleMessage.bind(this));
  }

  private async handleMessage(raw: unknown) {
    this.log.debug('Received raw Ipc message', { args: { raw } });
    // Guard: Skip everything that doesn't look like a message
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as IpcIncomingMessage;
    const { correlationId, action, requestId, payload } = msg;

    this.log.debug('Parsed IPC message', { args: { action, requestId, correlationId, payload } });

    if (typeof correlationId !== 'string' || !action) {
      this.log.debug('No action or correlationId provided, ignoring message');
      return;
    }

    if (action === 'pong') {
      return this.producer.markPong();
    }

    if (!this.producer.isConnected()) {
      this.log.debug('Connection not alive, ignoring message');
      // IMPORTANT: We do not process incoming messages
      // until a connection is established.
      return;
    }

    let responseAction: IpcOutgoingActions;
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

    this.log.debug('Sending response message', { args: { responseAction, requestId, responsePayload, correlationId } });
    await this.producer.sendMessage({ action: responseAction, payload: responsePayload, requestId }, { correlationId });
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
