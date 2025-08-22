import { BasicEvent } from '@easylayer/common/cqrs';

interface EvmNetworkInitializedEventPayload {}

export class EvmNetworkInitializedEvent extends BasicEvent<EvmNetworkInitializedEventPayload> {}
