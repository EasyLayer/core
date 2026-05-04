export const enum StrategyNames {
  RPC = 'rpc',
  WS_SUBSCRIBE = 'subscribe-ws',
}

export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}
