import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

interface BitcoinNetworkInitializedEventPayload extends EventBasePayload {}

@SystemEvent()
export class BitcoinNetworkInitializedEvent extends BasicEvent<BitcoinNetworkInitializedEventPayload> {}
