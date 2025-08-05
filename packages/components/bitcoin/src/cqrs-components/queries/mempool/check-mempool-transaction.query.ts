import { IsOptional, IsString } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface ICheckMempoolTransactionQuery {
  readonly txid: string;
}

export class CheckMempoolTransactionQueryDto {
  @IsString()
  @JSONSchema({
    description: 'Transaction ID to check in mempool',
    example: 'abc123def456789012345678901234567890123456789012345678901234567890',
  })
  txid!: string;
}

@QueryDoc({
  description: 'Checks if a specific transaction exists in mempool and retrieves its status',
  category: 'Mempool',
  examples: {
    request: {
      requestId: 'uuid-1',
      action: 'query',
      payload: {
        constructorName: 'CheckMempoolTransactionQuery',
        dto: {
          txid: 'abc123def456789012345678901234567890123456789012345678901234567890',
        },
      },
    },
    response: {
      txid: 'abc123def456789012345678901234567890123456789012345678901234567890',
      exists: true,
      isLoaded: true,
      wasAttempted: true,
      loadInfo: {
        timestamp: 1672531200000,
        feeRate: 100.5,
      },
    },
  },
})
export class CheckMempoolTransactionQuery {
  constructor(public readonly payload: ICheckMempoolTransactionQuery) {}
}
