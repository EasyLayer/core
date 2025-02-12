import { QuickNodeProviderOptions } from './quick-node.provider';
import { SelfNodeProviderOptions } from './self-node.provider';

export type Hash = `0x${string}`;

export const enum NodeProviderTypes {
  SELFNODE = 'selfnode',
  QUICKNODE = 'quicknode',
}

export interface NodeProviderTypeInterface {
  type: NodeProviderTypes;
}

export type ProviderNodeOptions =
  | (SelfNodeProviderOptions & NodeProviderTypeInterface)
  | (QuickNodeProviderOptions & NodeProviderTypeInterface);
