import { SystemEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

interface EvmNetworkClearedEventPayload extends EventBasePayload {}

@SystemEvent()
export class EvmNetworkClearedEvent extends BasicEvent<EvmNetworkClearedEventPayload> {}
