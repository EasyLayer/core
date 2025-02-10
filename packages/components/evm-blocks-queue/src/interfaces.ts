export interface Transaction {
  hash: string;
  nonce: number;
  blockHash: string | null;
  blockNumber: number | null;
  transactionIndex: number | null;
  from: string;
  to: string | null;
  value: string;
  gas: number;
  gasPrice: string;
  input: string;
}

export interface Block {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  transactions: Transaction[];
  size: number;
  gasLimit: number;
  gasUsed: number;
}

export interface BlocksCommandExecutor {
  handleBatch({ batch, requestId }: { batch: Block[]; requestId: string }): Promise<void>;
}
