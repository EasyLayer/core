import { BasicEvent } from '@easylayer/common/cqrs';
import type { EvmLoadedMempoolTx } from '../../../native';

export interface EvmMempoolRefreshedEventPayload {
  aggregatedMetadata: Record<string, EvmLoadedMempoolTx[]>;
  /** snapshot=txpool_content, additive=newPendingTransactions/WebSocket. */
  mode: 'snapshot' | 'additive';
}

export class EvmMempoolRefreshedEvent extends BasicEvent<EvmMempoolRefreshedEventPayload> {}
