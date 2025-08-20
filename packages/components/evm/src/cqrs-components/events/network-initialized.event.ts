import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

interface EvmNetworkInitializedEventPayload {}

@SystemEvent()
export class EvmNetworkInitializedEvent extends BasicEvent<EvmNetworkInitializedEventPayload> {}
