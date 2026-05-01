import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';
import type { MempoolTxMetadata } from '../../../blockchain-provider/providers/interfaces';

export interface ICheckMempoolTransactionFullQuery {
  readonly hash: string;
  readonly includeMetadata?: boolean;
}

export class CheckMempoolTransactionFullQueryDto {
  @IsString()
  @JSONSchema({ description: 'EVM transaction hash to check in mempool', example: '0xabc123...' })
  hash!: string;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({ description: 'Include stored mempool metadata for the transaction', default: false })
  includeMetadata?: boolean;
}

export interface CheckMempoolTransactionFullResult {
  hash: string;
  exists: boolean;
  isLoaded: boolean;
  metadata?: MempoolTxMetadata;
}

@QueryDoc({
  description: 'Full check of an EVM mempool transaction: existence, load status and optional metadata.',
  category: 'Mempool',
})
export class CheckMempoolTransactionFullQuery {
  constructor(public readonly payload: ICheckMempoolTransactionFullQuery) {}
}
