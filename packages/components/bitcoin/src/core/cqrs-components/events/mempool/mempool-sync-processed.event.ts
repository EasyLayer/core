import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightTransaction } from '../../../cqrs-components';

export interface BitcoinMempoolSyncProcessedEventPayload {
  loadedTransactions: Array<{
    txid: string;
    transaction: LightTransaction;
    /** Provider that served this batch (used for per‑provider adaptive sizing) */
    providerName?: string;
  }>;
  /** Optional: time spent to complete each provider batch, ms */
  batchDurations?: Record<string, number>;
}

export class BitcoinMempoolSyncProcessedEvent extends BasicEvent<BitcoinMempoolSyncProcessedEventPayload> {}
