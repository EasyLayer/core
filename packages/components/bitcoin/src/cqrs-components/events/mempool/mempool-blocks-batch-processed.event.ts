import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinMempoolBlockBatchProcessedEventPayload {
  txidsToRemove: string[];
}

@SystemEvent()
export class BitcoinMempoolBlockBatchProcessedEvent extends BasicEvent<BitcoinMempoolBlockBatchProcessedEventPayload> {}
