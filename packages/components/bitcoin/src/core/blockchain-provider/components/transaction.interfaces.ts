export interface Vin {
  txid?: string;
  vout?: number;
  scriptSig?: {
    asm: string;
    hex: string;
  };
  sequence?: number;
  coinbase?: string;
  txinwitness?: string[]; // SegWit witness data
}

export interface Vout {
  value: number;
  n: number;
  scriptPubKey?: {
    asm: string;
    hex: string;
    reqSigs?: number;
    type: string;
    /** Modern Bitcoin Core RPC shape. */
    address?: string;
    /** Legacy/deprecated Bitcoin Core compatibility shape. Prefer address when present. */
    addresses?: string[];
  };
}

export interface Transaction {
  txid: string;
  hash: string;
  version: number;
  // ===== ENHANCED SIZE FIELDS =====
  size: number; // Full size including witness data
  strippedsize: number; // Size WITHOUT witness data (base size)
  sizeWithoutWitnesses: number; // Alias for strippedsize for clarity
  vsize: number; // Virtual size (BIP 141)
  weight: number; // Transaction weight (BIP 141)
  witnessSize?: number; // Size of witness data only
  locktime: number;
  vin: Vin[];
  vout: Vout[];
  // NO hex! Processed at service level
  blockhash?: string;
  time?: number;
  blocktime?: number;
  /** Absolute fee in smallest units, e.g. satoshis for BTC. Optional when source path cannot know prevout values. */
  fee?: number;
  feeRate?: number; // smallest units per vbyte, e.g. sat/vB
  wtxid?: string; // SegWit transaction ID
  depends?: string[];
  spentby?: string[];
  bip125_replaceable?: boolean;
}
