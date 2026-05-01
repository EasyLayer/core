import { BasicEvent } from '@easylayer/common/cqrs';
import type { MempoolTxMetadata } from '../../../blockchain-provider/providers/interfaces';

export interface EvmMempoolRefreshedEventPayload {
  aggregatedMetadata: Record<string, Array<{ hash: string; metadata: MempoolTxMetadata }>>;
  /** snapshot=txpool_content, additive=newPendingTransactions/WebSocket. */
  mode: 'snapshot' | 'additive';
}

export class EvmMempoolRefreshedEvent extends BasicEvent<EvmMempoolRefreshedEventPayload> {}
