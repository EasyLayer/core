export interface TransctionsList {
  blockHash: string;
  blockHeight: number;
  transactions: Transaction[];
}

export interface TransactionsPage {
  page: number;
  blockHash: string;
  blockHeight: number;
  transactions: Transaction[];
  lastPage: boolean;
}

export interface TransactionsBatch {
  index: number;
  blockHash: string;
  blockHeight: number;
  transactions: Transaction[];
  isFinalBatch: boolean;
}
export interface Transaction {
  txid: string;
  hash: string;
  vin: any;
  vout: any;
  hex?: string;
  witness?: any;
  size: number;
}
// TODO: move to provider
export interface Block {
  height: number;
  hash: string;
  tx: Transaction[];
  size: number; // size in Bytes
}

export interface BlocksCommandExecutor {
  handleBatch({ batch, requestId }: { batch: Block[]; requestId: string }): Promise<void>;
}
