import { BasicEvent } from '@easylayer/common/cqrs';

export interface BitcoinMempoolSynchronizedEventPayload {}

export class BitcoinMempoolSynchronizedEvent extends BasicEvent<BitcoinMempoolSynchronizedEventPayload> {}
