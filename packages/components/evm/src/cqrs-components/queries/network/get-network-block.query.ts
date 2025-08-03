import { IsNumber, IsPositive } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';
import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkBlockQuery {
  readonly height: number;
}

export class GetNetworkBlockQueryDto {
  @IsNumber()
  @IsPositive()
  @JSONSchema({
    description: 'Block height to retrieve',
    example: 850000,
    minimum: 0,
  })
  height!: number;
}

@QueryDoc({
  description: 'Retrieves a specific block from the blockchain network by height',
  category: 'Network',
  examples: {
    request: {
      requestId: 'uuid-5',
      action: 'query',
      payload: {
        constructorName: 'GetNetworkBlockQuery',
        dto: {
          height: 850000,
        },
      },
    },
    response: {
      block: {
        height: 850000,
        hash: '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054',
        previousblockhash: '00000000000000000008b3a92d5e735e4e8e8e1b2c6f8a3b5d9f2c1a7e4b8d6c',
        tx: ['tx1', 'tx2', 'tx3'],
      },
      exists: true,
      chainStats: {
        currentHeight: 850500,
        totalBlocks: 1000,
      },
    },
  },
})
export class GetNetworkBlockQuery {
  constructor(public readonly payload: IGetNetworkBlockQuery) {}
}
