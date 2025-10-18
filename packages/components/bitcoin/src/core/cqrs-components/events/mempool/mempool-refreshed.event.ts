import { BasicEvent } from '@easylayer/common/cqrs';
import type { MempoolTxMetadata } from '../../../blockchain-provider';

export interface BitcoinMempoolRefreshedEventPayload {
  aggregatedMetadata: Record<
    string, // provider name
    Array<{ txid: string; metadata: MempoolTxMetadata }>
  >;
}

export class BitcoinMempoolRefreshedEvent extends BasicEvent<BitcoinMempoolRefreshedEventPayload> {}
