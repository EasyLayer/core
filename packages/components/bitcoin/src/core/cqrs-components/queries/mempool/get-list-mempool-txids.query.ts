import { IsOptional, IsNumber, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetListMempoolTxidsQuery {
  readonly offset?: number;
  readonly limit?: number;
  readonly minFeeRate?: number;
}

export class GetListMempoolTxidsQueryDto {
  @IsOptional()
  @IsNumber()
  @JSONSchema({ description: 'Offset for pagination', default: 0 })
  offset?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @JSONSchema({ description: 'Limit for pagination', default: 100, maximum: 1000 })
  limit?: number;

  @IsOptional()
  @IsNumber()
  @JSONSchema({ description: 'Filter: only txids with feeRate ≥ minFeeRate (sat/vB)', default: 0 })
  minFeeRate?: number;
}

export interface ListMempoolTxidsResult {
  total: number;
  items: string[];
  offset: number;
  limit: number;
}

@QueryDoc({
  description: 'Lists txids currently tracked in mempool, optionally filtered by minimum fee rate.',
  category: 'Mempool',
  examples: {
    request: {
      requestId: 'uuid-3',
      action: 'query',
      payload: { constructorName: 'GetListMempoolTxidsQuery', dto: { minFeeRate: 25, limit: 50 } },
    },
    response: { total: 12000, items: ['abc…', 'def…'], offset: 0, limit: 50 },
  },
})
export class GetListMempoolTxidsQuery {
  constructor(public readonly payload: IGetListMempoolTxidsQuery) {}
}
