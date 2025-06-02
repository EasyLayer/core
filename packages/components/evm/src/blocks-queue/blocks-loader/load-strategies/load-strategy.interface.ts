export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}

export enum StrategyNames {
  PULL = 'pull',
  SUBSCRIBE = 'subscribe',
}
