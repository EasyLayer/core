// import type { NodeProviderTypeInterface } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import type { BaseNodeProvider, BaseNodeProviderOptions } from './base-node-provider';
import type { RPCNodeProviderOptions } from './rpc-node.provider';
import { createRPCNodeProvider } from './rpc-node.provider';
import type { P2PNodeProviderOptions } from './p2p-node.provider';
import { createP2PNodeProvider } from './p2p-node.provider';

// Base type for all provider options with type discrimination
export type ProviderNodeOptions =
  | (RPCNodeProviderOptions & { type: NodeProviderTypes.RPC })
  | (P2PNodeProviderOptions & { type: NodeProviderTypes.P2P });

// Provider configuration interface
export interface ProviderOptions<T extends ProviderNodeOptions = ProviderNodeOptions> {
  connection?: Omit<T, 'uniqName' | 'network' | 'rateLimits'>;
  useFactory?: (
    options?: T
  ) => Promise<BaseNodeProvider<BaseNodeProviderOptions>> | BaseNodeProvider<BaseNodeProviderOptions>;
}

// Factory method with proper type discrimination
export function createProvider(options: ProviderNodeOptions): BaseNodeProvider<BaseNodeProviderOptions> {
  const { type, ...restOptions } = options;

  switch (type) {
    case NodeProviderTypes.RPC:
      return createRPCNodeProvider(restOptions as RPCNodeProviderOptions);
    case NodeProviderTypes.P2P:
      return createP2PNodeProvider(restOptions as P2PNodeProviderOptions);
    default: {
      // TypeScript exhaustiveness check
      const _exhaustiveCheck: never = type;
      throw new Error(`Unsupported provider type: ${_exhaustiveCheck}`);
    }
  }
}
