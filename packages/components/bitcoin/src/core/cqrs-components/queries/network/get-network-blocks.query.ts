import { IsOptional, IsBoolean, IsNumber, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkBlocksQuery {
  readonly lastN?: number;
  readonly all?: boolean;
}

export class GetNetworkBlocksQueryDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @JSONSchema({
    description: 'Number of recent blocks to retrieve (defaults to 10 if neither lastN nor all specified)',
    default: 10,
    example: 10,
    minimum: 1,
    maximum: 10000,
  })
  lastN?: number;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Retrieve all blocks in the chain (overrides lastN parameter)',
    default: false,
    example: false,
  })
  all?: boolean;
}

@QueryDoc({
  description: 'Retrieves multiple blocks from the blockchain network (last N blocks or all blocks)',
  category: 'Network',
  examples: {
    request: {
      requestId: 'uuid-6',
      action: 'query',
      payload: {
        constructorName: 'GetNetworkBlocksQuery',
        dto: {
          lastN: 10,
        },
      },
    },
    response: {
      blocks: [
        {
          height: 850000,
          hash: '000...054',
          previousblockhash: '000...d6c',
          tx: ['tx1', 'tx2'],
        },
      ],
      totalCount: 1000,
      requestedCount: 10,
      chainStats: {
        currentHeight: 850000,
        firstHeight: 849000,
      },
    },
  },
})
export class GetNetworkBlocksQuery {
  constructor(public readonly payload: IGetNetworkBlocksQuery) {}
}
