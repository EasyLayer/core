import type { QueryBus, IQuery } from '@easylayer/common/cqrs';
import { setQueryMetadata } from '@easylayer/common/cqrs';
import type { Envelope, QueryRequestPayload, QueryResponsePayload } from './messages';
import { Actions } from './messages';

export abstract class BaseConsumer {
  protected constructor() {}

  public async onMessage(message: Envelope, context?: unknown): Promise<void> {
    switch (message.action) {
      case Actions.Ping: {
        const reply: Envelope<{ ts: number }> = {
          action: Actions.Pong,
          payload: { ts: Date.now() },
          timestamp: Date.now(),
        };
        await this._send(reply, context);
        return;
      }
      case Actions.Pong: {
        await this.handlePong(message, context);
        return;
      }
      case Actions.QueryRequest: {
        await this.handleQueryMessage(message as Envelope<QueryRequestPayload>, context);
        return;
      }
      default: {
        await this.handleBusinessMessage(message, context);
        return;
      }
    }
  }

  protected async handlePong(_message: Envelope, _context?: unknown): Promise<void> {
    return;
  }

  protected async handleQueryMessage(_message: Envelope<QueryRequestPayload>, _context?: unknown): Promise<void> {
    return;
  }

  protected createQueryResponse(
    payload: QueryResponsePayload,
    requestId?: string,
    correlationId?: string
  ): Envelope<QueryResponsePayload> {
    return {
      action: Actions.QueryResponse,
      payload,
      requestId,
      correlationId,
      timestamp: Date.now(),
    };
  }

  protected async executeQuery(queryBus: QueryBus, req: QueryRequestPayload) {
    const constructorName = req?.name;
    const dto = req?.dto ?? {};
    if (!constructorName || typeof constructorName !== 'string') {
      throw new Error('Query name must be a non-empty string');
    }

    const Query = class {};
    Object.defineProperty(Query, 'name', { value: constructorName });
    setQueryMetadata(Query);

    const instance = Object.assign(Object.create(Query.prototype), { payload: dto }) as IQuery;
    return await queryBus.execute(instance);
  }

  protected abstract handleBusinessMessage(message: Envelope, context?: unknown): Promise<void>;
  protected abstract _send(message: Envelope, context?: unknown): Promise<void>;
}
