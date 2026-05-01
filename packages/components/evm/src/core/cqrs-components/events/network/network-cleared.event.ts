import { BasicEvent } from '@easylayer/common/cqrs';

export interface EvmNetworkClearedEventPayload {}

export class EvmNetworkClearedEvent extends BasicEvent<EvmNetworkClearedEventPayload> {}
