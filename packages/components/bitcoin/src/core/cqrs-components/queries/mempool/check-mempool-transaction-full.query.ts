import { IsOptional, IsString, IsBoolean } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';
import type { MempoolTxMetadata, MempoolTransaction } from '../../../blockchain-provider';

export interface ICheckMempoolTransactionFullQuery {
  readonly txid: string;
  readonly includeMetadata?: boolean;
  readonly includeTransaction?: boolean;
}

export class CheckMempoolTransactionFullQueryDto {
  @IsString()
  @JSONSchema({
    description: 'Transaction ID to check in mempool',
    example: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
  })
  txid!: string;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Include mempool metadata for the tx', default: false })
  includeMetadata?: boolean;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Include normalized transaction object', default: true })
  includeTransaction?: boolean;
}

export interface CheckMempoolTransactionFullResult {
  txid: string;
  exists: boolean;
  isLoaded: boolean;
  providers: string[];
  feeRate?: number;
  metadata?: MempoolTxMetadata;
  transaction?: MempoolTransaction;
}

@QueryDoc({
  description:
    'Full check of a mempool transaction: existence, load status, providers, feeRate; optionally metadata and transaction.',
  category: 'Mempool',
  examples: {
    request: {
      requestId: 'uuid-1',
      action: 'query',
      payload: {
        constructorName: 'CheckMempoolTransactionFullQuery',
        dto: { txid: 'abc123…7890', includeMetadata: true, includeTransaction: true },
      },
    },
    response: {
      txid: 'abc123…7890',
      exists: true,
      isLoaded: true,
      providers: ['provider_0', 'provider_1'],
      feeRate: 52.3,
      metadata: { fee: 20000, vsize: 382 /* ... */ },
      transaction: { txid: 'abc123…7890', vsize: 382 /* ... */ },
    },
  },
})
export class CheckMempoolTransactionFullQuery {
  constructor(public readonly payload: ICheckMempoolTransactionFullQuery) {}
}
