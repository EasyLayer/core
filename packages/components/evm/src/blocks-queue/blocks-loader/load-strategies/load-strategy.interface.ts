export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}

export enum StrategyNames {
  RPC_PULL = 'rpc_pull',
  WS_SUBSCRIBE = 'ws_subscribe',
}
