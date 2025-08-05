import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

interface BitcoinMempoolClearedEventPayload extends EventBasePayload {}

@SystemEvent()
export class BitcoinMempoolClearedEvent extends BasicEvent<BitcoinMempoolClearedEventPayload> {}
