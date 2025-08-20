import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

interface BitcoinNetworkInitializedEventPayload {}

@SystemEvent()
export class BitcoinNetworkInitializedEvent extends BasicEvent<BitcoinNetworkInitializedEventPayload> {}
