import { BasicEvent } from '@easylayer/common/cqrs';

export interface BitcoinMempoolTransactionsConfirmedEventPayload {
  /** txids of transactions that were confirmed in a block and must be removed from mempool */
  txids: string[];
  /** block height at which these transactions were confirmed */
  blockHeight: number;
}

export class BitcoinMempoolTransactionsConfirmedEvent extends BasicEvent<BitcoinMempoolTransactionsConfirmedEventPayload> {}
