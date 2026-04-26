// ===== UNIVERSAL INTERFACES (what providers return) =====

/**
 * Universal Block - structured data from provider
 * Contains hex for hex-based methods or no hex for object-based methods
 * Height is optional when parsing from hex without known height
 */
export interface UniversalBlock {
  hash: string;
  height?: number; // Optional when parsing from hex without height

  strippedsize?: number;
  size?: number;
  weight?: number;
  vsize?: number;

  version?: number;
  versionHex?: string;
  merkleroot?: string;
  time?: number;
  nonce?: number;
  bits?: string;
  difficulty?: string;
  previousblockhash?: string;

  // can be hashes or objects (providers must not mix per single block)
  tx?: string[] | UniversalTransaction[];

  // present when parsed from hex; absent for object calls
  hex?: string;

  nTx?: number;

  // Optional extended mining data (if provider enriches)
  fee?: number;
  subsidy?: number;
  miner?: string;
  pool?: {
    poolName?: string;
    url?: string;
  };
}

/**
 * Universal Block Stats - block statistics (raw provider shape)
 * Providers leave missing fields as undefined.
 */
export interface UniversalBlockStats {
  blockhash: string;
  height: number;

  total_size?: number;
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

  // Optional time
  time?: number;
}

/**
 * Universal Transaction - structured data from provider
 * Contains hex for hex-based methods or no hex for object-based methods
 *
 * NOTE:
 * - `strippedsize` and `witnessSize` are optional but SHOULD be provided by hex/bytes path.
 * - Some RPCs (verbosity=1/2) already include size/weight/vsize; providers must not invent values.
 */
export interface UniversalTransaction {
  txid: string;
  hash?: string;

  version?: number;
  size?: number;
  vsize?: number;
  weight?: number;
  strippedsize?: number; // added so normalizer can satisfy domain
  witnessSize?: number; // added so normalizer can satisfy domain
  locktime?: number;

  vin: UniversalVin[];
  vout: UniversalVout[];

  hex?: string; // present when parsed from hex, absent for object calls

  blockhash?: string;
  time?: number;
  blocktime?: number;
  confirmations?: number;

  fee?: number;
  wtxid?: string;

  depends?: string[];
  spentby?: string[];
  bip125_replaceable?: boolean;
}

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
    /** Modern Bitcoin Core RPC shape. */
    address?: string;
    /** Legacy/deprecated Bitcoin Core compatibility shape. Prefer address when present. */
    addresses?: string[];
  };
}

/**
 * Universal mempool info from provider.
 * All fields are optional except "loaded" (boolean).
 * Values are already converted to smallest units / per-vB where applicable by providers.
 */
export interface UniversalMempoolInfo {
  loaded: boolean;

  size?: number; // Number of transactions in mempool
  bytes?: number; // Total size of all transactions in bytes
  usage?: number; // Total memory usage for mempool in bytes
  total_fee?: number; // Total fee in smallest units (e.g., sats)
  maxmempool?: number; // Maximum mempool size in bytes
  mempoolminfee?: number; // Minimum fee rate in sat/vB
  minrelaytxfee?: number; // Minimum relay fee rate in sat/vB
  unbroadcastcount?: number;

  incrementalrelayfee?: number; // sat/vB
  fullrbf?: boolean;
}

/**
 * Universal mempool tx metadata from provider.
 * Providers should not coerce missing values to zero.
 */
export interface UniversalMempoolTxMetadata {
  txid: string;
  wtxid?: string;

  vsize?: number;
  weight?: number;

  // Absolute fees (smallest units, e.g., sats for BTC)
  fee?: number;
  modifiedfee?: number;

  time?: number;
  height?: number;

  // Relations
  depends?: string[];
  spentby?: string[];

  descendantcount?: number;
  descendantsize?: number;
  descendantfees?: number; // smallest units
  ancestorcount?: number;
  ancestorsize?: number;
  ancestorfees?: number; // smallest units

  fees: {
    base?: number; // smallest units
    modified?: number; // smallest units
    ancestor?: number; // smallest units
    descendant?: number; // smallest units
  };

  // RBF / unbroadcast
  bip125_replaceable?: boolean;
  unbroadcast?: boolean;
}
