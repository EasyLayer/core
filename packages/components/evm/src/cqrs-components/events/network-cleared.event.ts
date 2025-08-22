import { BasicEvent } from '@easylayer/common/cqrs';

interface EvmNetworkClearedEventPayload {}

export class EvmNetworkClearedEvent extends BasicEvent<EvmNetworkClearedEventPayload> {}
