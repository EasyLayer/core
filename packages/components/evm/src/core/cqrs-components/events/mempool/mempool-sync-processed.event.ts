import { BasicEvent } from '@easylayer/common/cqrs';
import type { EvmLoadedMempoolTxWithProvider } from '../../../native';

export interface EvmMempoolSyncProcessedEventPayload {
  loadedTransactions: EvmLoadedMempoolTxWithProvider[];
  /** Optional: time spent to complete each provider batch, ms. */
  batchDurations?: Record<string, number>;
}

export class EvmMempoolSyncProcessedEvent extends BasicEvent<EvmMempoolSyncProcessedEventPayload> {}
