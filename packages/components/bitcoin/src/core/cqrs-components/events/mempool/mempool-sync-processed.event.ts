import { BasicEvent } from '@easylayer/common/cqrs';
import type { LightTransaction } from '../../../cqrs-components';
export interface BitcoinMempoolSyncProcessedEventPayload {
  loadedTransactions: Array<{
    txid: string;
    transaction: LightTransaction;
    // Optional provider info for transactions loaded directly from specific providers
    providerIndex?: number;
    // providerName?: string;
    // metadata: any;
  }>;
  hasMoreToProcess: boolean; // true if there are still pending txids to load
}

export class BitcoinMempoolSyncProcessedEvent extends BasicEvent<BitcoinMempoolSyncProcessedEventPayload> {}
