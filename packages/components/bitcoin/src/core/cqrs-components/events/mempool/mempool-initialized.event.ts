import { BasicEvent } from '@easylayer/common/cqrs';

export interface BitcoinMempoolInitializedEventPayload {}

export class BitcoinMempoolInitializedEvent extends BasicEvent<BitcoinMempoolInitializedEventPayload> {}
