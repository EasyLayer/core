import { BasicEvent } from '@easylayer/common/cqrs';

export interface EvmMempoolInitializedEventPayload {}

export class EvmMempoolInitializedEvent extends BasicEvent<EvmMempoolInitializedEventPayload> {}
