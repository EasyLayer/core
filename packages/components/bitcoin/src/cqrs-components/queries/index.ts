export * from './fetch-events.query';
export * from './get-models.query';
export * from './interfaces';
export * from './network';
export * from './mempool';

import { NetworkQueries, NetworkQueryDtos, NetworkQueryDtoMap } from './network';
import { MempoolQueries, MempoolQueryDtos, MempoolQueryDtoMap } from './mempool';
import { FetchEventsQuery, FetchEventsQueryDto } from './fetch-events.query';
import { GetModelsQuery, GetModelsQueryDto } from './get-models.query';

export const AllQueries = [FetchEventsQuery, GetModelsQuery, ...NetworkQueries, ...MempoolQueries];

export const AllQueryDtos = [FetchEventsQueryDto, GetModelsQueryDto, ...NetworkQueryDtos, ...MempoolQueryDtos];

type QueryConstructor = new (...args: any[]) => any;
type DtoConstructor = new (...args: any[]) => any;

export const AllQueryDtoMap = new Map<QueryConstructor, DtoConstructor>([
  [FetchEventsQuery, FetchEventsQueryDto],
  [GetModelsQuery, GetModelsQueryDto],
  ...NetworkQueryDtoMap,
  ...MempoolQueryDtoMap,
]);

export { NetworkQueries, NetworkQueryDtos, NetworkQueryDtoMap };
export { MempoolQueries, MempoolQueryDtos, MempoolQueryDtoMap };
