import type { Block, MempoolTxMetadata } from '../blockchain-provider';

export interface BlocksCommandExecutor {
  handleBatch({ batch, requestId }: { batch: Block[]; requestId: string }): Promise<void>;
}

export type ProviderSnapshot = Record<
  string, // providerName
  Array<{ txid: string; metadata: MempoolTxMetadata }>
>;

export interface MempoolCommandExecutor {
  handleSnapshot(params: { requestId: string; height: number; perProvider: ProviderSnapshot }): Promise<void>;
}
