import { IsOptional, IsBoolean, IsNumber, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';
import type { MempoolTxMetadata } from '../../../blockchain-provider';
import type { LightTransaction } from '../../models';

export interface IGetListMempoolTransactionsQuery {
  readonly minFeeRate?: number;
  readonly maxFeeRate?: number;
  readonly loadedOnly?: boolean;
  readonly includeMetadata?: boolean;
  readonly offset?: number;
  readonly limit?: number;
}

export class GetListMempoolTransactionsQueryDto {
  @IsOptional()
  @IsNumber()
  @JSONSchema({ description: 'Minimum fee rate (sat/vB)', default: 0 })
  minFeeRate?: number;

  @IsOptional()
  @IsNumber()
  @JSONSchema({ description: 'Maximum fee rate (sat/vB)', default: Number.POSITIVE_INFINITY })
  maxFeeRate?: number;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Return only transactions already loaded locally', default: false })
  loadedOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Include metadata for each transaction', default: false })
  includeMetadata?: boolean;

  @IsOptional()
  @IsNumber()
  @JSONSchema({ description: 'Offset for pagination', default: 0 })
  offset?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @JSONSchema({ description: 'Limit for pagination', default: 100, maximum: 500 })
  limit?: number;
}

export interface ListedTransactionEntry {
  txid: string;
  feeRate: number;
  transaction?: LightTransaction;
  metadata?: MempoolTxMetadata;
}

export interface ListMempoolTransactionsResult {
  total: number;
  items: ListedTransactionEntry[];
  offset: number;
  limit: number;
}

@QueryDoc({
  description: 'Lists mempool transactions within a fee-rate range; optionally only loaded ones and with metadata.',
  category: 'Mempool',
  examples: {
    request: {
      requestId: 'uuid-4',
      action: 'query',
      payload: {
        constructorName: 'GetListMempoolTransactionsQuery',
        dto: { minFeeRate: 20, loadedOnly: true, includeMetadata: false, limit: 50 },
      },
    },
    response: {
      total: 1200,
      items: [
        {
          txid: 'abc123…',
          feeRate: 102.4,
          transaction: { txid: 'abc123…', vsize: 382 /* … */ },
        },
      ],
      offset: 0,
      limit: 50,
    },
  },
})
export class GetListMempoolTransactionsQuery {
  constructor(public readonly payload: IGetListMempoolTransactionsQuery) {}
}
