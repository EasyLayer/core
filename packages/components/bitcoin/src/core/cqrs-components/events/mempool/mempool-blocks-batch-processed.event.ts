import { BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinMempoolBlockBatchProcessedEventPayload {
  txidsToRemove: string[];
}

export class BitcoinMempoolBlockBatchProcessedEvent extends BasicEvent<BitcoinMempoolBlockBatchProcessedEventPayload> {}
