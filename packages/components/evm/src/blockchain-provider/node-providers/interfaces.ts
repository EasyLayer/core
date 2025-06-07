export type Hash = `0x${string}`;

export const enum NodeProviderTypes {
  ETHERJS = 'ethersjs',
  WEB3JS = 'web3js',
}

export interface RateLimits {
  /** Maximum requests per second (default: 12 for QuickNode free plan) */
  maxRequestsPerSecond?: number;
  /** Maximum concurrent requests (default: 10) */
  maxConcurrentRequests?: number;
  /** Maximum batch size for parallel requests (default: 25) */
  maxBatchSize?: number;
}

export interface NodeProviderTypeInterface {
  type: NodeProviderTypes;
}
