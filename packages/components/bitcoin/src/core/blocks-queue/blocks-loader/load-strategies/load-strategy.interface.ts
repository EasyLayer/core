export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}

export enum StrategyNames {
  RPC = 'rpc',
  P2P = 'p2p',
  SUBSCRIBE = 'subscribe',
}
