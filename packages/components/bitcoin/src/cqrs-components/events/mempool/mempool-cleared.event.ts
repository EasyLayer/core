import { BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinMempoolClearedEventPayload {}

export class BitcoinMempoolClearedEvent extends BasicEvent<BitcoinMempoolClearedEventPayload> {}
