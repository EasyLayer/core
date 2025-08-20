import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinMempoolClearedEventPayload {}

@SystemEvent()
export class BitcoinMempoolClearedEvent extends BasicEvent<BitcoinMempoolClearedEventPayload> {}
