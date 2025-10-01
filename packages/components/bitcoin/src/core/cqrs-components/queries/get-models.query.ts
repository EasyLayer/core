import { IsOptional, IsString, IsArray } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';
import type { Filter } from './interfaces';

export interface IGetModelsQuery {
  readonly modelIds: string[];
  readonly filter: Filter;
}

export class GetModelsQueryDto {
  @IsArray()
  @IsString({ each: true })
  @JSONSchema({
    description: 'Array of model IDs to retrieve current state for',
    example: ['mempool-1', 'network-1'],
  })
  modelIds!: string[];

  @IsOptional()
  @JSONSchema({
    description: 'Filter criteria for model state retrieval',
    example: { blockHeight: 100 },
  })
  filter?: Filter;
}

@QueryDoc({
  description: 'Retrieves the current state of one or more models at a specified block height',
  category: 'Core',
  examples: {
    request: {
      requestId: 'uuid-models-1',
      action: 'query',
      payload: {
        constructorName: 'GetModelsQuery',
        dto: {
          modelIds: ['mempool-1', 'network-1'],
          filter: {
            blockHeight: 100,
          },
        },
      },
    },
    response: [
      {
        aggregateId: 'mempool-1',
        state: {
          totalTxids: 50000,
          loadedTransactions: 45000,
          isSynchronized: true,
        },
      },
      {
        aggregateId: 'network-1',
        state: {
          size: 1000,
          currentHeight: 850000,
          isEmpty: false,
        },
      },
    ],
  },
})
export class GetModelsQuery {
  constructor(public readonly payload: IGetModelsQuery) {}
}
