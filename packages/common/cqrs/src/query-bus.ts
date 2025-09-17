import { Injectable } from '@nestjs/common';
import type { IQuery, IQueryHandler, Type } from './interfaces';
import { QUERY_HANDLER_METADATA } from './constants';

/**
 * - Matches query by constructor name to a single handler.
 * - Queries return a value (R).
 * - Errors are propagated to the caller (NOT to UnhandledExceptionBus).
 */

@Injectable()
export class QueryBus<Q extends IQuery = IQuery> {
  private readonly handlers = new Map<string, IQueryHandler<Q>>();

  bind<H extends IQueryHandler<Q>>(handler: H, name: string) {
    this.handlers.set(name, handler);
  }

  async execute<T extends Q, R = any>(query: T): Promise<R> {
    const key = (query as any)?.constructor?.name;
    const h = key ? this.handlers.get(key) : undefined;
    if (!h) throw new Error(`No query handler for ${key}`);
    return await Promise.resolve(h.execute(query) as any);
  }

  registerInstances(handlers: IQueryHandler[]) {
    for (const h of handlers) {
      const ctor = (h as any).constructor as Type;
      const q: Type | undefined = Reflect.getMetadata(QUERY_HANDLER_METADATA, ctor);
      if (q) this.bind(h as any, q.name);
    }
  }
}
