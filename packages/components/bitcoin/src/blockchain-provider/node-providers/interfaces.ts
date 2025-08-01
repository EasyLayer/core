export const enum NodeProviderTypes {
  SELFNODE = 'selfnode',
}

/**
 * Rate limiting configuration interface
 */
export interface RateLimits {
  /** Maximum concurrent requests (default: 1) */
  maxConcurrentRequests?: number;
  /** Maximum batch size for parallel requests (default: 15) */
  maxBatchSize?: number;
  /** Delay between requests in milliseconds (default: 1000) */
  requestDelayMs?: number;
}

export interface NodeProviderTypeInterface {
  type: NodeProviderTypes;
}

// Bitcoin Network Configuration
export interface NetworkConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
  // Bitcoin-specific configurations
  hasSegWit: boolean;
  hasTaproot: boolean;
  hasRBF: boolean; // Replace-by-Fee
  hasCSV: boolean; // CheckSequenceVerify
  hasCLTV: boolean; // CheckLockTimeVerify
  // Block and transaction limits
  maxBlockSize: number;
  maxBlockWeight: number;
  // Mining difficulty adjustment
  difficultyAdjustmentInterval: number; // blocks
  targetBlockTime: number; // seconds
}

// ===== UNIVERSAL INTERFACES (what providers return) =====

/**
 * Universal Vin - raw data from provider
 */
export interface UniversalVin {
  txid?: string;
  vout?: number;
  scriptSig?: {
    asm: string;
    hex: string;
  };
  sequence?: number;
  coinbase?: string;
  txinwitness?: string[]; // witness data if present
}

/**
 * Universal Vout - raw data from provider
 */
export interface UniversalVout {
  value: number;
  n: number;
  scriptPubKey?: {
    asm: string;
    hex: string;
    reqSigs?: number;
    type: string;
    addresses?: string[];
    address?: string;
  };
}

/**
 * Universal Transaction - structured data from provider
 * Contains hex for hex-based methods or no hex for object-based methods
 */
export interface UniversalTransaction {
  txid: string;
  hash: string;
  version: number;
  size: number;
  vsize: number;
  weight: number;
  locktime: number;
  vin: UniversalVin[];
  vout: UniversalVout[];
  hex?: string; // present when parsed from hex, absent for object calls
  blockhash?: string;
  time?: number;
  blocktime?: number;
  fee?: number;
  wtxid?: string;
  depends?: string[];
  spentby?: string[];
  bip125_replaceable?: boolean;
}

/**
 * Universal Block - structured data from provider
 * Contains hex for hex-based methods or no hex for object-based methods
 * Height is optional when parsing from hex without known height
 */
export interface UniversalBlock {
  hash: string;
  height?: number; // Optional when parsing from hex without height
  strippedsize: number;
  size: number;
  weight: number;
  version: number;
  versionHex: string;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: string;
  chainwork: string;
  previousblockhash?: string;
  nextblockhash?: string;
  tx?: string[] | UniversalTransaction[]; // can be hashes or objects
  hex?: string; // present when parsed from hex, absent for object calls
  nTx?: number;
  fee?: number;
  subsidy?: number;
  miner?: string;
  pool?: {
    poolName: string;
    url: string;
  };
}

/**
 * Universal Block Stats - block statistics
 */
export interface UniversalBlockStats {
  blockhash: string;
  height: number;
  total_size: number;
  total_weight?: number;
  total_fee?: number;
  fee_rate_percentiles?: number[];
  subsidy?: number;
  total_out?: number;
  utxo_increase?: number;
  utxo_size_inc?: number;
  ins?: number;
  outs?: number;
  txs?: number;
  minfee?: number;
  maxfee?: number;
  medianfee?: number;
  avgfee?: number;
  minfeerate?: number;
  maxfeerate?: number;
  medianfeerate?: number;
  avgfeerate?: number;
  mintxsize?: number;
  maxtxsize?: number;
  mediantxsize?: number;
  avgtxsize?: number;

  // Additional fields for enhanced statistics
  total_stripped_size?: number; // Size without witness data
  witness_txs?: number; // Number of SegWit transactions
}

export interface UniversalMempoolTransaction {
  // Basic transaction info
  txid: string;
  wtxid?: string;
  size: number;
  vsize: number;
  weight: number;
  fee: number;
  modifiedfee: number;
  time: number;
  height: number;

  // Family relationships
  depends: string[];
  descendantcount: number;
  descendantsize: number;
  descendantfees: number;
  ancestorcount: number;
  ancestorsize: number;
  ancestorfees: number;

  // Fee structure
  fees: {
    base: number;
    modified: number;
    ancestor: number;
    descendant: number;
  };

  // BIP125 RBF
  bip125_replaceable: boolean;

  // Unbroadcast flag
  unbroadcast?: boolean;
}
