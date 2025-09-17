import { IsOptional, IsBoolean, IsNumber, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetMempoolTransactionsQuery {
  readonly onlyLoaded?: boolean;
  readonly streaming?: boolean;
  readonly batchSize?: number;
}

export class GetMempoolTransactionsQueryDto {
  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Return only fully loaded transactions (excludes null placeholders)',
    default: false,
    example: true,
  })
  onlyLoaded?: boolean;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Enable streaming response for large datasets',
    default: false,
    example: true,
  })
  streaming?: boolean;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @JSONSchema({
    description: 'Number of transactions per batch when streaming',
    default: 100,
    example: 100,
    minimum: 1,
    maximum: 10000,
  })
  batchSize?: number;
}

@QueryDoc({
  description: 'Retrieves mempool transactions with optional streaming support for large datasets',
  category: 'Mempool',
  streaming: true,
  examples: {
    request: {
      requestId: 'uuid-3',
      action: 'streamQuery',
      payload: {
        constructorName: 'GetMempoolTransactionsQuery',
        dto: {
          streaming: true,
          onlyLoaded: true,
          batchSize: 100,
        },
      },
    },
    response: {
      type: 'batch',
      data: {
        batch: [
          {
            txid: 'abc123...',
            transaction: {
              vsize: 250,
              fees: { base: 25000 },
              time: 1672531200,
            },
          },
        ],
        batchIndex: 0,
        hasMore: true,
      },
    },
  },
})
export class GetMempoolTransactionsQuery {
  constructor(public readonly payload: IGetMempoolTransactionsQuery) {}
}
