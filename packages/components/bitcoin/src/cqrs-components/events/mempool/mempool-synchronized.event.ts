import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

export interface BitcoinMempoolSynchronizedEventPayload {
  isSynchronized: boolean;
}

@SystemEvent()
export class BitcoinMempoolSynchronizedEvent extends BasicEvent<BitcoinMempoolSynchronizedEventPayload> {}
