export type Hash = `0x${string}`;

export const enum NodeProviderTypes {
  ETHERJS = 'ethersjs',
  WEB3JS = 'web3js',
  JSON_RPC = 'jsonrpc',
}

export interface RateLimits {
  /** Maximum requests per second (default: 12 for QuickNode free plan) */
  maxRequestsPerSecond?: number;
  /** Maximum concurrent requests (default: 10) */
  maxConcurrentRequests?: number;
  /** Maximum batch size for parallel requests (default: 25) */
  maxBatchSize?: number;
}

export interface NodeProviderTypeInterface {
  type: NodeProviderTypes;
}

export interface NetworkConfig {
  chainId: number;
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
  blockTime: number; // Average block time in seconds
  hasEIP1559: boolean; // Supports EIP-1559
  hasWithdrawals: boolean; // Supports staking withdrawals
  hasBlobTransactions: boolean; // Supports EIP-4844 blob transactions
}

// ===== UNIVERSAL INTERFACES FOR PROVIDERS =====
// These interfaces handle all possible fields from different providers and networks

export interface UniversalWithdrawal {
  index: string; // Withdrawal index (hex string)
  validatorIndex: string; // Validator index (hex string)
  address: string; // Withdrawal recipient address
  amount: string; // Withdrawal amount in Gwei (hex string)
}

export interface UniversalAccessListEntry {
  address: string; // Contract address
  storageKeys: string[]; // Array of storage slot keys
}

export interface UniversalBlock {
  // Core fields (present in all versions)
  hash: string;
  parentHash: string;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot: string;
  miner: string;
  difficulty: string;
  totalDifficulty: string;
  extraData: string;
  size: number;
  gasLimit: number;
  gasUsed: number;
  timestamp: number;
  uncles: string[];

  // Block number - handle different provider naming
  blockNumber: number;

  // Optional hex representation
  hex?: string;

  // EIP-1559 fields (London fork, August 2021+)
  baseFeePerGas?: string;

  // Shanghai fork fields (March 2023+)
  withdrawals?: UniversalWithdrawal[];
  withdrawalsRoot?: string;

  // Cancun fork fields (March 2024+)
  blobGasUsed?: string;
  excessBlobGas?: string;
  parentBeaconBlockRoot?: string;

  // Transactions and receipts
  transactions?: UniversalTransaction[];
  receipts?: UniversalTransactionReceipt[];
}

export interface UniversalTransaction {
  // Core fields (all versions)
  hash: string;
  nonce: number;
  from: string;
  to: string | null;
  value: string;
  gas: number;
  input: string;

  // Block references - handle different provider formats
  blockHash?: string | null;
  blockNumber?: number | null;
  transactionIndex?: number | null;

  // // Optional hex representation
  // hex?: string;
  // raw?: string;
  // serialized?: string;

  // Legacy transaction fields
  gasPrice?: string; // Legacy and EIP-2930

  // EIP-155 signature fields (2016+)
  chainId?: number;
  v?: string; // Optional for unsigned transactions
  r?: string; // Optional for unsigned transactions
  s?: string; // Optional for unsigned transactions

  // EIP-1559 fields (Type 2, London fork August 2021+)
  type?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;

  // EIP-2930 fields (Type 1, Berlin fork April 2021+)
  accessList?: UniversalAccessListEntry[];

  // EIP-4844 fields (Type 3, Cancun fork March 2024+)
  maxFeePerBlobGas?: string;
  blobVersionedHashes?: string[];
}

export interface UniversalTransactionReceipt {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  blockNumber: number;
  from: string;
  to: string | null;
  cumulativeGasUsed: number;
  gasUsed: number;
  contractAddress: string | null;
  logs: UniversalLog[];
  logsBloom: string;
  status: '0x0' | '0x1';

  // EIP-1559 fields
  type?: string;
  effectiveGasPrice?: number;

  // EIP-4844 fields
  blobGasUsed?: string;
  blobGasPrice?: string;
}

export interface UniversalLog {
  address: string; // Contract address that emitted the log
  topics: string[]; // Array of log topics (topic[0] is event signature)
  data: string; // Log data as a hex string
  blockNumber?: number | null; // Block number where the log was emitted
  transactionHash?: string | null; // Transaction hash containing this log
  transactionIndex?: number | null; // Index of the transaction in the block
  blockHash?: string | null; // Block hash where the log was included
  logIndex?: number | null; // Log index within the block
  removed?: boolean; // True if the log was removed due to a chain reorganization
}
