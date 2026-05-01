export type Hash = `0x${string}`;

export const enum NodeProviderTypes {
  ETHERJS = 'ethersjs',
  WEB3JS = 'web3js',
}

export type ReceiptsStrategy = 'auto' | 'block-receipts' | 'transaction-receipts';
export type TraceStrategy = 'auto' | 'debug-trace' | 'parity-trace';
export type MempoolStrategy = 'disabled' | 'subscribe-ws' | 'txpool-content';

/**
 * Light policy layer for client/fork/provider differences. It is intentionally
 * generic: callers pass policy from outside instead of hardcoding chain names.
 */
export interface EvmFieldPolicy {
  requiredBlockFields?: string[];
  optionalBlockFields?: string[];
  requiredReceiptFields?: string[];
  allowLegacyReceiptRoot?: boolean;
  allowMissingTotalDifficulty?: boolean;
  allowMissingLogsBloom?: boolean;
  allowMissingNonce?: boolean;
  minerFieldAliases?: string[];
}

/**
 * Rate limiting configuration interface for EVM JSON-RPC providers.
 */
export interface RateLimits {
  /** Maximum concurrent scheduled RPC batches (default: 1). */
  maxConcurrentRequests?: number;

  /** Maximum JSON-RPC calls per batch (default: 15). */
  maxBatchSize?: number;

  /** Minimum time between batch starts in milliseconds (preferred). */
  minTimeMsBetweenRequests?: number;

  /** Legacy alias for `minTimeMsBetweenRequests`. Ignored if preferred value is provided. */
  requestDelayMs?: number;

  /** Optional token bucket settings. */
  reservoir?: number;
  reservoirRefreshInterval?: number;
  reservoirRefreshAmount?: number;
}

export interface NetworkConfig {
  chainId: number;
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
  blockTime: number; // Average block time in seconds

  // EIP/fork support flags. These describe the configured network profile and
  // are checked by crawlers/providers without chain-name hardcoding.
  hasEIP1559: boolean;
  hasWithdrawals: boolean;
  hasBlobTransactions: boolean;

  // Block and transaction limits
  maxBlockSize: number;
  maxBlockWeight: number;
  maxGasLimit: number;
  maxTransactionSize: number;

  // Gas configuration
  minGasPrice: string;
  maxBaseFeePerGas?: string;
  maxPriorityFeePerGas?: string;

  // Blob support
  maxBlobGasPerBlock?: number;
  targetBlobGasPerBlock?: number;
  maxCodeSize: number;
  maxInitCodeSize: number;

  // EVM-specific additions
  supportsTraces: boolean;
  targetBlockTimeMs: number;

  receiptsStrategy?: ReceiptsStrategy;
  traceStrategy?: TraceStrategy;
  mempoolStrategySupport?: MempoolStrategy[];
  fieldPolicy?: Partial<EvmFieldPolicy>;
}

// ===== UNIVERSAL INTERFACES =====

export interface UniversalWithdrawal {
  index: string;
  validatorIndex: string;
  address: string;
  /** Amount in the smallest native unit as a decimal string. */
  amount: string;
}

export interface UniversalAccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface UniversalLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: number | null;
  transactionHash?: string | null;
  transactionIndex?: number | null;
  blockHash?: string | null;
  logIndex?: number | null;
  removed?: boolean;
}

export interface UniversalTransaction {
  hash: string;
  nonce: number;
  from: string;
  to: string | null;
  /** Wei/token amount as a decimal string. */
  value: string;
  gas: number;
  input: string;
  blockHash?: string | null;
  blockNumber?: number | null;
  transactionIndex?: number | null;
  /** Wei fee fields as decimal strings. */
  gasPrice?: string;
  chainId?: number;
  v?: string;
  r?: string;
  s?: string;
  type?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  accessList?: UniversalAccessListEntry[];
  maxFeePerBlobGas?: string;
  blobVersionedHashes?: string[];
}

export interface UniversalTransactionReceipt {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  from: string;
  to: string | null;
  cumulativeGasUsed: number;
  gasUsed: number;
  contractAddress: string | null;
  logs: UniversalLog[];
  logsBloom?: string;
  status?: '0x0' | '0x1';
  /** Legacy pre-Byzantium receipts expose root instead of status. */
  root?: string;
  type?: string;
  /** Wei fee field as a decimal string. */
  effectiveGasPrice?: string;
  blockNumber?: number;
  blobGasUsed?: string;
  blobGasPrice?: string;
}

export interface UniversalBlock {
  hash: string;
  parentHash: string;
  nonce?: string;
  sha3Uncles?: string;
  logsBloom?: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot?: string;
  miner: string;
  /** Numeric fields that can exceed JS safe integer are decimal strings. */
  difficulty?: string;
  totalDifficulty?: string;
  extraData: string;
  size?: number;
  gasLimit: number;
  gasUsed: number;
  timestamp: number;
  uncles: string[];
  blockNumber?: number;
  hex?: string;
  /** Wei fee field as a decimal string. */
  baseFeePerGas?: string;
  withdrawals?: UniversalWithdrawal[];
  withdrawalsRoot?: string;
  blobGasUsed?: string;
  excessBlobGas?: string;
  parentBeaconBlockRoot?: string;
  transactions?: Array<UniversalTransaction | string>;
  receipts?: UniversalTransactionReceipt[];
}

export interface UniversalBlockStats {
  hash: string;
  number: number;
  size?: number;
  gasLimit: number;
  gasUsed: number;
  gasUsedPercentage: number;
  timestamp: number;
  transactionCount: number;
  /** Wei fee field as a decimal string. */
  baseFeePerGas?: string;
  blobGasUsed?: string;
  excessBlobGas?: string;
  miner: string;
  difficulty?: string;
  parentHash: string;
  unclesCount: number;
}

/** Raw trace object from debug_traceBlockByNumber (Geth) or trace_block (Erigon/OpenEthereum). */
export interface UniversalTrace {
  transactionHash?: string;
  transactionPosition?: number;
  type?: string;
  action?: Record<string, any>;
  result?: Record<string, any>;
  error?: string;
  subtraces?: number;
  traceAddress?: number[];
}

/**
 * EVM pending transaction metadata stored in Mempool aggregate.
 * input/calldata is intentionally NOT stored — too large.
 * User can call getPendingTransactionByHash() for full data.
 */
export interface MempoolTxMetadata {
  hash: string;
  from: string;
  to: string | null;
  nonce: number;
  /** Wei/token amount as a decimal string. */
  value: string;
  gas: number;
  /** Wei fee fields as decimal strings. */
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  type?: string;
}
