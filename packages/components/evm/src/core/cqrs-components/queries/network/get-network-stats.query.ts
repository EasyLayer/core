import { QueryDoc } from '@easylayer/common/shared-interfaces';

export interface IGetNetworkStatsQuery {}
export class GetNetworkStatsQueryDto {}

@QueryDoc({ description: 'Retrieves EVM Network aggregate statistics and validation state', category: 'Network' })
export class GetNetworkStatsQuery {
  constructor(public readonly payload: IGetNetworkStatsQuery) {}
}
