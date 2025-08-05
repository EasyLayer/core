import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

export interface BitcoinMempoolSynchronizedEventPayload extends EventBasePayload {
  isSynchronized: boolean;
}

@SystemEvent()
export class BitcoinMempoolSynchronizedEvent extends BasicEvent<BitcoinMempoolSynchronizedEventPayload> {}
