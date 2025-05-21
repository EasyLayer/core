import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus, IQuery, setQueryMetadata } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { IncomingMessage, DefaultIncomingActions } from '../interfaces';
import { TcpOutgoingMessage, TcpOutgoingActions, TcpProducer } from './tcp.producer';

// This is TCP Consumer

type TcpIncomingActions = DefaultIncomingActions;

export interface TcpPayload {
  constructorName: string;
  dto: any;
}

export interface TcpIncomingMessage extends IncomingMessage<TcpIncomingActions, TcpPayload> {}

@Controller()
export class TcpController {
  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
    private readonly producer: TcpProducer,
    private readonly log: AppLogger
  ) {}

  @MessagePattern('messages')
  async handleMessage(@Payload() raw: unknown): Promise<TcpOutgoingMessage | undefined> {
    this.log.debug('Received raw Tcp message', { args: { raw } });

    // Guard: Skip everything that doesn't look like a message
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as IncomingMessage<DefaultIncomingActions, TcpPayload>;
    const { action, payload, requestId } = msg;
    this.log.debug('Parsed TCP message', { args: { action, requestId, payload } });

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

    let responseAction: TcpOutgoingActions;
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
    return { action: responseAction, payload: responsePayload, requestId };
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
