export const enum StrategyNames {
  RPC_PULL = 'pull-rpc',
  WS_SUBSCRIBE = 'subscribe-ws',
}

export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}
