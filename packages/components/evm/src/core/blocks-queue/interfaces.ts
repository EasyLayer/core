import type { Block } from '../blockchain-provider/components/block.interfaces';
import type { MempoolSnapshot } from '../cqrs-components/models/mempool/mempool.model';

export interface BlocksCommandExecutor {
  handleBatch({ batch, requestId }: { batch: Block[]; requestId: string }): Promise<void>;
}

export interface MempoolCommandExecutor {
  handleSnapshot({
    requestId,
    height,
    perProvider,
    mode,
  }: {
    requestId: string;
    height: number;
    perProvider: MempoolSnapshot;
    mode: 'snapshot' | 'additive';
  }): Promise<void>;
}
