import { Web3jsProviderOptions } from './web3js.provider';
import { EtherJSProviderOptions } from './etherjs.provider';

export type Hash = `0x${string}`;

export type NodeProviderTypes = 'etherjs' | 'web3js';

export interface NodeProviderTypeInterface {
  type: NodeProviderTypes;
}

export type ProviderNodeOptions =
  | (EtherJSProviderOptions & NodeProviderTypeInterface)
  | (Web3jsProviderOptions & NodeProviderTypeInterface);
