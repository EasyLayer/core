import { BasicEvent } from '@easylayer/common/cqrs';

export interface BitcoinMempoolInitializedEventPayload {
  allTxidsFromNode: string[];
  isSynchronized?: boolean;
  // Provider mapping data for multi-provider support
  // Maps txid to array of provider indices that have this transaction
  providerTxidMapping?: Record<string, number[]>;
  aggregatedMetadata: any;
}

export class BitcoinMempoolInitializedEvent extends BasicEvent<BitcoinMempoolInitializedEventPayload> {}
