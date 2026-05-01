import { NodeProviderTypes } from './interfaces';
import type { RateLimits, NetworkConfig } from './interfaces';
import type { BaseNodeProvider, BaseNodeProviderOptions } from './base.provider';
import type { Web3jsProviderOptions } from './web3js.provider';
import { createWeb3jsProvider } from './web3js.provider';
import type { EtherJSProviderOptions } from './etherjs.provider';
import { createEtherJSProvider } from './etherjs.provider';

export interface ProviderConnectionOptions {
  httpUrl: string;
  wsUrl?: string;
}

export interface ProviderCreateOptions {
  type: NodeProviderTypes;
  uniqName: string;
  httpUrl: string;
  wsUrl?: string;
  rateLimits: RateLimits;
  network: NetworkConfig;
}

export interface ProviderOptions {
  connection?: ProviderConnectionOptions;
  useFactory?: () => Promise<BaseNodeProvider> | BaseNodeProvider;
}

export function createProvider(options: ProviderCreateOptions): BaseNodeProvider<BaseNodeProviderOptions> {
  const { type, ...rest } = options;
  switch (type) {
    case NodeProviderTypes.ETHERJS:
      return createEtherJSProvider(rest as EtherJSProviderOptions);
    case NodeProviderTypes.WEB3JS:
      return createWeb3jsProvider(rest as Web3jsProviderOptions);
    default:
      throw new Error(`Unsupported provider type: ${type}`);
  }
}
