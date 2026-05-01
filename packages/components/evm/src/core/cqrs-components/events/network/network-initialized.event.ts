import { BasicEvent } from '@easylayer/common/cqrs';

export interface EvmNetworkInitializedEventPayload {}

export class EvmNetworkInitializedEvent extends BasicEvent<EvmNetworkInitializedEventPayload> {}
