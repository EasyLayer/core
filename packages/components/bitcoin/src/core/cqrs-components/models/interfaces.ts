// light.interfaces.ts
import type { Block, Transaction } from '../../blockchain-provider';

/**
 * Lightweight block view:
 * - keep only header linkage + height
 * - tx list as txids (strings),
 */
export type LightBlock = Pick<Block, 'hash' | 'height' | 'merkleroot'> & {
  /** transaction ids present in block */
  tx: string[];
  previousblockhash: string;
};

/** Lightweight scriptPubKey for vout */
export interface LightScriptPubKey {
  type?: string;
  addresses?: string[];
  /** hex kept for address derivation if addresses[] absent */
  hex?: string;
}

/** Lightweight vin: only data needed for RBF/dep checks */
export interface LightVin {
  txid?: string;
  vout?: number;
  /** required for BIP-125 signaling check */
  sequence?: number;
}

/** Lightweight vout: numeric value + minimal script */
export interface LightVout {
  value: number;
  n: number;
  scriptPubKey?: LightScriptPubKey;
}

/**
 * Lightweight transaction for mempool/queue processing:
 * - drop heavyweight fields (full scripts, witnesses, block context, etc.)
 * - keep sizes, basic io sets (light vin/vout), fee/feerate
 */
export type LightTransaction = Omit<
  Transaction,
  'vin' | 'vout' | 'blockhash' | 'time' | 'blocktime' | 'depends' | 'spentby' | 'witnessSize'
> & {
  vin: LightVin[];
  vout: LightVout[];
  /** sat/vB; optional if not computed upstream */
  feeRate?: number;
};
