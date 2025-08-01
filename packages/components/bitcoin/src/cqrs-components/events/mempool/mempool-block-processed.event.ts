import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

export interface BitcoinMempoolBlockProcessedEventPayload extends EventBasePayload {
  allTxidsFromNode: string[];
  isSynchronized: boolean;
}

@SystemEvent()
export class BitcoinMempoolBlockProcessedEvent extends BasicEvent<BitcoinMempoolBlockProcessedEventPayload> {}
