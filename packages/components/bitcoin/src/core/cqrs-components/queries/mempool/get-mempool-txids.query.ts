import { IsOptional, IsBoolean, IsNumber, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetMempoolTxidsQuery {
  readonly streaming?: boolean;
  readonly batchSize?: number;
  readonly includeLoadInfo?: boolean;
}

export class GetMempoolTxidsQueryDto {
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
    description: 'Number of transaction IDs per batch when streaming',
    default: 1000,
    example: 1000,
    minimum: 1,
    maximum: 50000,
  })
  batchSize?: number;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Include load attempt information (timestamp and fee rate)',
    default: false,
    example: true,
  })
  includeLoadInfo?: boolean;
}

@QueryDoc({
  description: 'Retrieves transaction IDs currently tracked in mempool with optional load information',
  category: 'Mempool',
  streaming: true,
  examples: {
    request: {
      requestId: 'uuid-4',
      action: 'streamQuery',
      payload: {
        constructorName: 'GetMempoolTxidsQuery',
        dto: {
          streaming: true,
          batchSize: 1000,
          includeLoadInfo: true,
        },
      },
    },
    response: {
      type: 'currentTxids',
      data: {
        batch: ['abc123def456...', 'def789abc123...', 'fed321cba987...'],
        batchIndex: 0,
        hasMore: true,
      },
    },
  },
})
export class GetMempoolTxidsQuery {
  constructor(public readonly payload: IGetMempoolTxidsQuery) {}
}
