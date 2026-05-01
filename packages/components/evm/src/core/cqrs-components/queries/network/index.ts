export * from './get-network-stats.query';
export * from './get-network-block.query';
export * from './get-network-blocks.query';
export * from './get-network-last-block.query';

import { GetNetworkStatsQuery, GetNetworkStatsQueryDto } from './get-network-stats.query';
import { GetNetworkBlockQuery, GetNetworkBlockQueryDto } from './get-network-block.query';
import { GetNetworkBlocksQuery, GetNetworkBlocksQueryDto } from './get-network-blocks.query';
import { GetNetworkLastBlockQuery, GetNetworkLastBlockQueryDto } from './get-network-last-block.query';

export const NetworkQueries = [
  GetNetworkStatsQuery,
  GetNetworkBlockQuery,
  GetNetworkBlocksQuery,
  GetNetworkLastBlockQuery,
];

export const NetworkQueryDtos = [
  GetNetworkStatsQueryDto,
  GetNetworkBlockQueryDto,
  GetNetworkBlocksQueryDto,
  GetNetworkLastBlockQueryDto,
];

export const NetworkQueryDtoMap = new Map([
  [GetNetworkStatsQuery, GetNetworkStatsQueryDto],
  [GetNetworkBlockQuery, GetNetworkBlockQueryDto],
  [GetNetworkBlocksQuery, GetNetworkBlocksQueryDto],
  [GetNetworkLastBlockQuery, GetNetworkLastBlockQueryDto],
]);
