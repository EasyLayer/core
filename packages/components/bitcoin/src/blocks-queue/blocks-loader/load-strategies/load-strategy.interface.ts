export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}

export enum StrategyNames {
  PULL_NETWORK_PROVIDER = 'pull-network-provider',
}
