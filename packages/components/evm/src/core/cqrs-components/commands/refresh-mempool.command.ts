import type { MempoolSnapshot } from '../models/mempool/mempool.model';

export interface IRefreshMempoolCommand {
  requestId: string;
  height: number;
  perProvider: MempoolSnapshot;
  /** snapshot=txpool_content, additive=newPendingTransactions/WebSocket. */
  mode: 'snapshot' | 'additive';
}

export class RefreshMempoolCommand {
  constructor(public readonly payload: IRefreshMempoolCommand) {}
}
