export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}

export enum StrategyNames {
  RPC_PULL = 'rpc_pull',
  P2P_PROCESS = 'p2p_process',
  // ZMQ_SUBSCRIBE = 'zmq_subscribe',
}
