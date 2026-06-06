import type { Block, MempoolTxMetadata } from '../blockchain-provider';

export interface RawBlock {
  hash: string;
  height: number;
  size: number;
  bytes: Buffer;
  /** Header previousblockhash, when available from realtime raw metadata. */
  prevHash?: string;
}

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
