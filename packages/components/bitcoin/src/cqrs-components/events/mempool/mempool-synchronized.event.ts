import { BasicEvent } from '@easylayer/common/cqrs';

export interface BitcoinMempoolSynchronizedEventPayload {
  isSynchronized: boolean;
}

export class BitcoinMempoolSynchronizedEvent extends BasicEvent<BitcoinMempoolSynchronizedEventPayload> {}
