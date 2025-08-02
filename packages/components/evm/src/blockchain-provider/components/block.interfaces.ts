import type { Transaction, TransactionReceipt } from './transaction.interfaces';

export type LightBlock = {
  blockNumber: number;
  hash: string;
  parentHash: string;
  transactions: string[];
};

export interface Withdrawal {
  index: string;
  validatorIndex: string;
  address: string;
  amount: string;
}

export interface Block {
  // Core fields (always present)
  hash: string;
  parentHash: string;
  blockNumber: number; // Always normalized to this field
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
  gasLimit: number;
  gasUsed: number;
  timestamp: number;
  uncles: string[];
  size: number; // Total size including receipts
  sizeWithoutReceipts: number; // Original block size without receipts

  // Optional fields based on network capabilities
  baseFeePerGas?: string; // Only if network supports EIP-1559
  withdrawals?: Withdrawal[]; // Only if network supports withdrawals
  withdrawalsRoot?: string; // Only if network supports withdrawals
  blobGasUsed?: string; // Only if network supports blob transactions
  excessBlobGas?: string; // Only if network supports blob transactions
  parentBeaconBlockRoot?: string; // Only if network supports blob transactions

  // Transactions and receipts
  transactions?: Transaction[];
  receipts?: TransactionReceipt[];
}
