import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinNetworkClearedEventPayload {}

@SystemEvent()
export class BitcoinNetworkClearedEvent extends BasicEvent<BitcoinNetworkClearedEventPayload> {}
