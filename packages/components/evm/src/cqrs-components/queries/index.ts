export * from './fetch-events.query';
export * from './get-models.query';
export * from './interfaces';
export * from './network';

import { NetworkQueries, NetworkQueryDtos, NetworkQueryDtoMap } from './network';
import { FetchEventsQuery, FetchEventsQueryDto } from './fetch-events.query';
import { GetModelsQuery, GetModelsQueryDto } from './get-models.query';

export const AllQueries = [FetchEventsQuery, GetModelsQuery, ...NetworkQueries];

export const AllQueryDtos = [FetchEventsQueryDto, GetModelsQueryDto, ...NetworkQueryDtos];

type QueryConstructor = new (...args: any[]) => any;
type DtoConstructor = new (...args: any[]) => any;

export const AllQueryDtoMap = new Map<QueryConstructor, DtoConstructor>([
  [FetchEventsQuery, FetchEventsQueryDto],
  [GetModelsQuery, GetModelsQueryDto],
  ...NetworkQueryDtoMap,
]);

export { NetworkQueries, NetworkQueryDtos, NetworkQueryDtoMap };
