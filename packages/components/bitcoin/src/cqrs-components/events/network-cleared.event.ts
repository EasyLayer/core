import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

interface BitcoinNetworkClearedEventPayload extends EventBasePayload {}

@SystemEvent()
export class BitcoinNetworkClearedEvent extends BasicEvent<BitcoinNetworkClearedEventPayload> {}
