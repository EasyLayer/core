import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkStatsQuery {}

export class GetNetworkStatsQueryDto {}

@QueryDoc({
  description: 'Retrieves blockchain network statistics and chain validation status',
  category: 'Network',
  examples: {
    request: {
      requestId: 'uuid-8',
      action: 'query',
      payload: {
        constructorName: 'GetNetworkStatsQuery',
        dto: {},
      },
    },
    response: {
      size: 1000,
      maxSize: 2000,
      currentHeight: 850000,
      firstHeight: 849000,
      isEmpty: false,
      isFull: false,
      isValid: true,
    },
  },
})
export class GetNetworkStatsQuery {
  constructor(public readonly payload: IGetNetworkStatsQuery) {}
}
