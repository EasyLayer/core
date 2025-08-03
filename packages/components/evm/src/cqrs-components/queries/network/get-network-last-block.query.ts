import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkLastBlockQuery {}

export class GetNetworkLastBlockQueryDto {}

@QueryDoc({
  description: 'Retrieves the last (most recent) block from the blockchain network',
  category: 'Network',
  examples: {
    request: {
      requestId: 'uuid-7',
      action: 'query',
      payload: {
        constructorName: 'GetNetworkLastBlockQuery',
        dto: {},
      },
    },
    response: {
      lastBlock: {
        height: 850000,
        hash: '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054',
        previousblockhash: '00000000000000000008b3a92d5e735e4e8e8e1b2c6f8a3b5d9f2c1a7e4b8d6c',
        tx: ['tx1', 'tx2', 'tx3'],
      },
      hasBlocks: true,
      chainStats: {
        size: 1000,
        currentHeight: 850000,
        isEmpty: false,
      },
    },
  },
})
export class GetNetworkLastBlockQuery {
  constructor(public readonly payload: IGetNetworkLastBlockQuery) {}
}
