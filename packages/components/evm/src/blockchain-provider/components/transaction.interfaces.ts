export interface AccessListEntry {
  address: string; // Contract address
  storageKeys: string[]; // Array of storage slot keys
}

export interface Transaction {
  // Core fields (always present)
  hash: string;
  blockHash: string;
  blockNumber: number;
  transactionIndex: number;
  nonce: number;
  from: string;
  to: string | null;
  value: string;
  gas: number;
  input: string;
  type: string; // Always present, defaults to "0x0" for legacy

  // Signature fields (always present for mined transactions)
  chainId: number;
  v: string;
  r: string;
  s: string;

  // Gas pricing fields (conditional based on transaction type and network)
  gasPrice?: string; // For legacy transactions or networks without EIP-1559
  maxFeePerGas?: string; // For EIP-1559 transactions
  maxPriorityFeePerGas?: string; // For EIP-1559 transactions

  // Optional fields
  accessList?: AccessListEntry[]; // For EIP-2930 and EIP-1559 transactions
  maxFeePerBlobGas?: string; // For blob transactions
  blobVersionedHashes?: string[]; // For blob transactions

  // hex?: string; // Optional hex representation (for size calculations, raw transactions, etc.)
}

export interface TransactionReceipt {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  blockNumber: number;
  from: string;
  to: string | null;
  cumulativeGasUsed: number;
  gasUsed: number;
  contractAddress: string | null;
  logs: Log[];
  logsBloom: string;
  status: '0x0' | '0x1';
  type: string;
  effectiveGasPrice: number;

  // Optional fields based on network capabilities
  blobGasUsed?: string;
  blobGasPrice?: string;
}

export interface Log {
  address: string; // Contract address that emitted the log
  topics: string[]; // Array of log topics (topic[0] is event signature)
  data: string; // Log data as a hex string
  blockNumber: number; // Block number where the log was emitted
  transactionHash: string; // Transaction hash containing this log
  transactionIndex: number; // Index of the transaction in the block
  blockHash: string; // Block hash where the log was included
  logIndex: number; // Log index within the block
  removed: boolean; // True if the log was removed due to a chain reorganization
}
