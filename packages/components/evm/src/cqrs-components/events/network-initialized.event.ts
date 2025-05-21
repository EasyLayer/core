import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

interface EvmNetworkInitializedEventPayload extends EventBasePayload {}

@SystemEvent()
export class EvmNetworkInitializedEvent extends BasicEvent<EvmNetworkInitializedEventPayload> {}
