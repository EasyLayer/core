import { BasicEvent } from '@easylayer/common/cqrs';

export interface EvmMempoolTxsConfirmedEventPayload {
  confirmedHashes: string[];
}

export class EvmMempoolTxsConfirmedEvent extends BasicEvent<EvmMempoolTxsConfirmedEventPayload> {}
