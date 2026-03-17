/**
 * A Subscription is a Promise that resolves once unsubscribed, and also provides
 * an `unsubscribe()` method to cancel the underlying subscription.
 * Mirrors the type defined in BlockchainProviderService — kept here to avoid
 * circular imports between blocks-queue and blockchain-provider layers.
 */
export type Subscription = Promise<void> & { unsubscribe: () => void };

export interface BlocksLoadingStrategy {
  readonly name: StrategyNames;
  load(currentNetworkHeight: number): Promise<void>;
  stop(): Promise<void>;
}

export enum StrategyNames {
  RPC = 'rpc', // RPC batch pull only — polling via exponential timer (browser-safe)
  RPC_ZMQ = 'rpc-zmq', // RPC batch pull + ZMQ real-time subscription (Node/Electron only)
  P2P = 'p2p', // P2P GetData catch-up + P2P block stream (Node only)
}
