import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

export interface BitcoinMempoolInitializedEventPayload extends EventBasePayload {
  allTxidsFromNode: string[];
  isSynchronized: boolean;
}

@SystemEvent()
export class BitcoinMempoolInitializedEvent extends BasicEvent<BitcoinMempoolInitializedEventPayload> {}
