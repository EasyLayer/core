export interface Log {
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

export interface TransactionReceipt {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  from: string;
  to: string | null;
  cumulativeGasUsed: number;
  gasUsed: number;
  contractAddress: string | null;
  logs: Log[];
  logsBloom?: string;
  /** Post-Byzantium receipts use status; legacy receipts can expose root instead. */
  status?: '0x0' | '0x1';
  root?: string;
  type?: string;
  /** Wei fee field as a decimal string. */
  effectiveGasPrice?: string;
  blockNumber?: number;
  blobGasUsed?: string;
  blobGasPrice?: string;
}

export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface Transaction {
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
  accessList?: AccessListEntry[];
  maxFeePerBlobGas?: string;
  blobVersionedHashes?: string[];
}
