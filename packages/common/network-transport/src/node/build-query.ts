import { setQueryMetadata } from '@easylayer/common/cqrs';
import type { IQuery } from '@easylayer/common/cqrs';

export function buildQuery({ name, dto = {} }: { name: string; dto?: any }) {
  if (!name || typeof name !== 'string') {
    throw new Error('name is required and must be a string');
  }

  // Dynamic query construction using CQRS pattern
  const Query = class {};
  Object.defineProperty(Query, 'name', { value: name });

  setQueryMetadata(Query);

  const instance = Object.assign(Object.create(Query.prototype), { payload: dto }) as IQuery;
  return instance;
}
