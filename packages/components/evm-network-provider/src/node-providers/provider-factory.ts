import { ProviderNodeOptions } from './interfaces';
import { BaseNodeProvider, BaseNodeProviderOptions } from './base-node-provider';
import { Web3jsProviderOptions, createWeb3jsProvider } from './web3js.provider';
import { EtherJSProviderOptions, createEtherJSProvider } from './etherjs.provider';

export interface ProviderOptions<T extends ProviderNodeOptions = ProviderNodeOptions> {
  connection?: ProviderNodeOptions;
  useFactory?: (options?: T) => Promise<BaseNodeProvider<T>> | BaseNodeProvider<T>;
}

// Factory method
export function createProvider(options: ProviderNodeOptions): BaseNodeProvider<BaseNodeProviderOptions> {
  // TODO: Add validation

  const { type, ...restOptions } = options;
  switch (type) {
    case 'etherjs':
      return createEtherJSProvider(restOptions as EtherJSProviderOptions);
    case 'web3js':
      return createWeb3jsProvider(restOptions as Web3jsProviderOptions);
    default:
      throw new Error(`Unsupported provider type: ${type}`);
  }
}
