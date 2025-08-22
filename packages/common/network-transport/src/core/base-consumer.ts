import type { QueryBus, IQuery } from '@easylayer/common/cqrs';
import { setQueryMetadata } from '@easylayer/common/cqrs';
import type { IncomingMessage, OutgoingMessage, BasePayload } from '../shared';
import { ErrorUtils, BadRequestError, NotFoundError } from '../shared';

/**
 * BaseConsumer receives incoming transport frames (from sockets, IPC, HTTP bodies),
 * validates and routes them. It never "sends" anything by itself; it calls Producer to emit responses.
 *
 * Lifecycle overview (for WS/IPС):
 * - App starts: Producer begins periodic `ping` broadcast; Consumer listens for `pong`.
 * - First `pong` toggles Producer to "connected". Manager sees connected producers.
 * - Queries: Consumer receives 'query' or 'streamQuery' messages, executes CQRS Query via QueryBus,
 *   and asks Producer to `sendMessage()` with 'queryResponse' or stream chunk messages.
 * - Outbox streaming: Consumer handles **ACK** frames ('outboxStreamAck') and calls
 *   `producer.resolveOutboxAck(batchId, result)` to unblock the sender side.
 */
export abstract class BaseConsumer {
  /** Feature flag: allow 'streamQuery' handler */
  protected enableStreamQuery: boolean = false;

  /**
   * Execute CQRS query dynamically by constructorName.
   * We allocate a throwaway class with that runtime name and set CQRS metadata.
   */
  protected async executeQuery(
    queryBus: QueryBus,
    { constructorName, dto = {} }: { constructorName: string; dto: any }
  ) {
    if (!constructorName || typeof constructorName !== 'string') {
      throw new BadRequestError('constructorName is required and must be a string');
    }

    try {
      const Query = class {};
      Object.defineProperty(Query, 'name', { value: constructorName });
      setQueryMetadata(Query);
      const instance = Object.assign(Object.create(Query.prototype), { payload: dto }) as IQuery;
      return await queryBus.execute(instance);
    } catch (error: any) {
      if (error.message?.includes('No handler found')) {
        throw new NotFoundError(`Query handler not found for: ${constructorName}`);
      }
      throw error;
    }
  }

  /**
   * Build standard response envelope.
   */
  protected createResponse(
    action: 'queryResponse' | 'streamResponse' | 'streamEnd' | 'error',
    payload: any,
    requestId?: string
  ): OutgoingMessage {
    return { action, payload, requestId, timestamp: Date.now() };
  }

  protected createErrorResponse(error: any, requestId?: string): OutgoingMessage {
    return this.createResponse('error', ErrorUtils.toErrorPayload(error), requestId);
  }

  protected validateMessage(message: any): message is IncomingMessage {
    return message && typeof message === 'object' && typeof message.action === 'string';
  }

  protected validateQueryPayload(payload: any): payload is BasePayload {
    return (
      !!payload &&
      typeof payload === 'object' &&
      typeof payload.constructorName === 'string' &&
      payload.constructorName.length > 0
    );
  }

  /**
   * Generic streaming query helper:
   * - If handler returns async iterable, we yield chunks as 'streamResponse'.
   * - If it returns array, we send items one-by-one (simple backpressure).
   * - Always ends with 'streamEnd'.
   */
  protected async *handleStreamingQuery(
    queryBus: QueryBus,
    payload: BasePayload
  ): AsyncGenerator<OutgoingMessage, OutgoingMessage, unknown> {
    const result = await this.executeQuery(queryBus, {
      constructorName: payload.constructorName,
      dto: { ...payload.dto, streaming: true },
    });

    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      for await (const item of result) yield this.createResponse('streamResponse', item);
    } else if (Array.isArray(result)) {
      for (const item of result) yield this.createResponse('streamResponse', item);
    } else {
      yield this.createResponse('streamResponse', result);
    }
    return this.createResponse('streamEnd', undefined);
  }
}
