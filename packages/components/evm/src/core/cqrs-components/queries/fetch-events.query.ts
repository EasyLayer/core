import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';
import type { Filter, PaginationDto } from './interfaces';

export interface IFetchEventsQuery {
  readonly modelIds: string[];
  readonly filter: Filter;
  readonly paging: PaginationDto;
  readonly streaming?: boolean;
}

export class FetchEventsQueryDto {
  @IsArray()
  @IsString({ each: true })
  @JSONSchema({ description: 'Array of model IDs to fetch events for', example: ['mempool-1', 'network-1'] })
  modelIds!: string[];

  @IsOptional()
  @JSONSchema({ description: 'Filter criteria for events', example: { blockHeight: 19000000 } })
  filter?: Filter;

  @IsOptional()
  @JSONSchema({ description: 'Pagination settings for event retrieval', example: { limit: 10, offset: 0 } })
  paging?: PaginationDto;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Enable streaming response for large event datasets', default: false, example: true })
  streaming?: boolean;
}

@QueryDoc({
  description: 'Retrieves EVM events for one or more models with pagination and filtering options',
  category: 'Core',
  streaming: true,
})
export class FetchEventsQuery {
  constructor(public readonly payload: IFetchEventsQuery) {}
}
