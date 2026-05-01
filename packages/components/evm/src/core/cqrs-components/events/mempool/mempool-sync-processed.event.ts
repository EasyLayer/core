import { BasicEvent } from '@easylayer/common/cqrs';
import type { MempoolTxMetadata } from '../../../blockchain-provider/providers/interfaces';

export interface EvmMempoolSyncProcessedEventPayload {
  loadedTransactions: Array<{ hash: string; metadata: MempoolTxMetadata; providerName?: string }>;
  /** Optional: time spent to complete each provider batch, ms. */
  batchDurations?: Record<string, number>;
}

export class EvmMempoolSyncProcessedEvent extends BasicEvent<EvmMempoolSyncProcessedEventPayload> {}
