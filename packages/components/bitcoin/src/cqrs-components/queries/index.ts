export * from './fetch-events.query';
export * from './get-models.query';
export * from './interfaces';
export * from './mempool';
export * from './network';

import { MempoolQueries, MempoolQueryDtos, MempoolQueryDtoMap } from './mempool';
import { NetworkQueries, NetworkQueryDtos, NetworkQueryDtoMap } from './network';
import { FetchEventsQuery, FetchEventsQueryDto } from './fetch-events.query';
import { GetModelsQuery, GetModelsQueryDto } from './get-models.query';

export const AllQueries = [FetchEventsQuery, GetModelsQuery, ...MempoolQueries, ...NetworkQueries];

export const AllQueryDtos = [FetchEventsQueryDto, GetModelsQueryDto, ...MempoolQueryDtos, ...NetworkQueryDtos];

type QueryConstructor = new (...args: any[]) => any;
type DtoConstructor = new (...args: any[]) => any;

export const AllQueryDtoMap = new Map<QueryConstructor, DtoConstructor>([
  [FetchEventsQuery, FetchEventsQueryDto],
  [GetModelsQuery, GetModelsQueryDto],
  ...MempoolQueryDtoMap,
  ...NetworkQueryDtoMap,
]);

export { MempoolQueries, MempoolQueryDtos, MempoolQueryDtoMap };
export { NetworkQueries, NetworkQueryDtos, NetworkQueryDtoMap };
