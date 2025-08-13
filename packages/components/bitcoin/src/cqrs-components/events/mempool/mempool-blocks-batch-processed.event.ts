import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

interface BitcoinMempoolBlockBatchProcessedEventPayload extends EventBasePayload {
  txidsToRemove: string[];
}

@SystemEvent()
export class BitcoinMempoolBlockBatchProcessedEvent extends BasicEvent<BitcoinMempoolBlockBatchProcessedEventPayload> {}
