import type { QueryBus, IQuery } from '@easylayer/common/cqrs';
import { setQueryMetadata } from '@easylayer/common/cqrs';
import type { IncomingMessage, OutgoingMessage, BasePayload } from '../shared';
import { ErrorUtils, BadRequestError, NotFoundError } from '../shared';

/**
 * Base class for handling incoming messages in server transports
 */
export abstract class BaseConsumer {
  /**
   * Execute a CQRS query dynamically
   */
  protected async executeQuery(
    queryBus: QueryBus,
    { constructorName, dto = {} }: { constructorName: string; dto: any }
  ) {
    if (!constructorName || typeof constructorName !== 'string') {
      throw new BadRequestError('constructorName is required and must be a string');
    }

    try {
      // Dynamic query construction using CQRS pattern
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

  protected createResponse(
    action: 'queryResponse' | 'streamResponse' | 'streamEnd' | 'error',
    payload: any,
    requestId?: string
  ): OutgoingMessage {
    return {
      action,
      payload,
      requestId,
      timestamp: Date.now(),
    };
  }

  /**
   * Create error response from exception
   */
  protected createErrorResponse(error: any, requestId?: string): OutgoingMessage {
    return this.createResponse('error', ErrorUtils.toErrorPayload(error), requestId);
  }

  /**
   * Validate incoming message format
   */
  protected validateMessage(message: any): message is IncomingMessage {
    return message && typeof message === 'object' && typeof message.action === 'string';
  }

  /**
   * Validate query payload format
   */
  protected validateQueryPayload(payload: any): payload is BasePayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    if (!payload.constructorName || typeof payload.constructorName !== 'string') {
      return false;
    }

    return true;
  }

  /**
   * Handle streaming query with proper end marker - works for all transports
   * Returns async generator that yields streamResponse messages and ends with streamEnd
   */
  protected async *handleStreamingQuery(
    queryBus: QueryBus,
    payload: BasePayload
  ): AsyncGenerator<OutgoingMessage, OutgoingMessage, unknown> {
    try {
      const result = await this.executeQuery(queryBus, {
        constructorName: payload.constructorName,
        dto: { ...payload.dto, streaming: true },
      });

      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        // Handle async iterable - for real streaming data
        for await (const item of result) {
          yield this.createResponse('streamResponse', item);
        }
      } else if (Array.isArray(result)) {
        // Handle array - split large arrays into chunks
        for (const item of result) {
          yield this.createResponse('streamResponse', item);
        }
      } else {
        // Single response
        yield this.createResponse('streamResponse', result);
      }

      // Always send stream end marker
      return this.createResponse('streamEnd', undefined);
    } catch (error) {
      throw error; // Let caller handle error response
    }
  }
}
