import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import type { MempoolTransaction } from '../../../blockchain-provider';

export interface BitcoinMempoolSyncProcessedEventPayload extends EventBasePayload {
  loadedTransactions: Array<{
    txid: string;
    transaction: MempoolTransaction;
  }>;
  hasMoreToProcess: boolean; // true if there are still pending txids to load
}

@SystemEvent()
export class BitcoinMempoolSyncProcessedEvent extends BasicEvent<BitcoinMempoolSyncProcessedEventPayload> {}
