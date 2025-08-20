import { SystemEvent, BasicEvent } from '@easylayer/common/cqrs';

interface EvmNetworkClearedEventPayload {}

@SystemEvent()
export class EvmNetworkClearedEvent extends BasicEvent<EvmNetworkClearedEventPayload> {}
