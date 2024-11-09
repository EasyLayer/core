import { QuickNodeProviderOptions } from './quick-node.provider';
import { SelfNodeProviderOptions } from './self-node.provider';

export type Hash = `0x${string}`;

export type NodeProviderTypes = 'selfnode' | 'quicknode';

export interface NodeProviderTypeInterface {
  type: NodeProviderTypes;
}

export type ProviderNodeOptions =
  | (SelfNodeProviderOptions & NodeProviderTypeInterface)
  | (QuickNodeProviderOptions & NodeProviderTypeInterface);
