import type { ProviderNodeOptions } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import type { BaseNodeProvider, BaseNodeProviderOptions } from './base-node-provider';
import type { QuickNodeProviderOptions } from './quick-node.provider';
import { createQuickNodeProvider } from './quick-node.provider';
import type { SelfNodeProviderOptions } from './self-node.provider';
import { createSelfNodeProvider } from './self-node.provider';

export interface ProviderOptions<T extends ProviderNodeOptions = ProviderNodeOptions> {
  connection?: ProviderNodeOptions;
  useFactory?: (options?: T) => Promise<BaseNodeProvider<T>> | BaseNodeProvider<T>;
}

// Factory method
export function createProvider(options: ProviderNodeOptions): BaseNodeProvider<BaseNodeProviderOptions> {
  // TODO: Add validation

  const { type, ...restOptions } = options;
  switch (type) {
    case NodeProviderTypes.SELFNODE:
      return createSelfNodeProvider(restOptions as SelfNodeProviderOptions);
    case NodeProviderTypes.QUICKNODE:
      return createQuickNodeProvider(restOptions as QuickNodeProviderOptions);
    default:
      throw new Error(`Unsupported provider type: ${type}`);
  }
}
