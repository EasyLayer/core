import type { NodeProviderTypeInterface } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import type { BaseNodeProvider, BaseNodeProviderOptions } from './base-node-provider';
import type { SelfNodeProviderOptions } from './self-node.provider';
import { createSelfNodeProvider } from './self-node.provider';

export type ProviderNodeOptions = SelfNodeProviderOptions & NodeProviderTypeInterface;

export interface ProviderOptions<T extends ProviderNodeOptions = ProviderNodeOptions> {
  connection?: Omit<T, 'uniqName' | 'network' | 'rateLimits'>; // TODO: think about uniqName
  useFactory?: (options?: T) => Promise<BaseNodeProvider<T>> | BaseNodeProvider<T>;
}

// Factory method
export function createProvider(options: ProviderNodeOptions): BaseNodeProvider<BaseNodeProviderOptions> {
  // TODO: Add validation

  const { type, ...restOptions } = options;
  switch (type) {
    case NodeProviderTypes.SELFNODE:
      return createSelfNodeProvider(restOptions as SelfNodeProviderOptions);
    default:
      throw new Error(`Unsupported provider type: ${type}`);
  }
}
