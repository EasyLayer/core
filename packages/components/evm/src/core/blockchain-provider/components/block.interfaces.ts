import type { Transaction, TransactionReceipt } from './transaction.interfaces';

export interface Withdrawal {
  index: string;
  validatorIndex: string;
  address: string;
  /** Amount in the smallest native unit as a decimal string. */
  amount: string;
}

/**
 * Trace object returned by debug_traceBlockByNumber (Geth) or trace_block (Erigon).
 * Only present in Block when tracesEnabled=true in configuration.
 * Traces are NOT stored in LightBlock or Network aggregate — they are ephemeral.
 */
export interface Trace {
  transactionHash: string;
  transactionPosition: number;
  type: 'call' | 'create' | 'suicide' | 'reward' | string;
  action: Record<string, any>;
  result?: Record<string, any>;
  error?: string;
  subtraces: number;
  traceAddress: number[];
}

/**
 * LightBlock — stored in Network aggregate.
 * Contains only hashes/roots for chain validation. Fork/client-dependent fields are optional.
 */
export type LightBlock = {
  blockNumber: number;
  hash: string;
  parentHash: string;
  transactionsRoot: string;
  receiptsRoot?: string;
  stateRoot: string;
  transactions: string[];
  receipts: string[];
};

/**
 * Full Block — passes through BlocksQueue and into processBlock(ctx).
 * traces field is only populated when tracesEnabled=true.
 * After processBlock completes, block goes out of scope and GC handles traces.
 */
export interface Block {
  // Core continuity fields (always required after normalization)
  hash: string;
  parentHash: string;
  blockNumber: number;
  transactionsRoot: string;
  stateRoot: string;
  miner: string;
  extraData: string;
  gasLimit: number;
  gasUsed: number;
  timestamp: number;
  uncles: string[];
  size: number;
  sizeWithoutReceipts: number;

  // Common execution/client fields. Some L2/provider/fork responses may omit them.
  nonce?: string;
  sha3Uncles?: string;
  logsBloom?: string;
  receiptsRoot?: string;
  difficulty?: string;
  /** Newer Ethereum clients can omit totalDifficulty. */
  totalDifficulty?: string;

  // Fork-specific (optional)
  baseFeePerGas?: string;
  withdrawals?: Withdrawal[];
  withdrawalsRoot?: string;
  blobGasUsed?: string;
  excessBlobGas?: string;
  parentBeaconBlockRoot?: string;

  // Data
  transactionHashes?: string[];
  transactions?: Transaction[];
  receipts?: TransactionReceipt[];
  traces?: Trace[];
}
