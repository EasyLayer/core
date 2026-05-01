import { BasicEvent } from '@easylayer/common/cqrs';

export interface EvmMempoolSynchronizedEventPayload {}

export class EvmMempoolSynchronizedEvent extends BasicEvent<EvmMempoolSynchronizedEventPayload> {}
