import { BasicEvent } from '@easylayer/common/cqrs';

export interface EvmMempoolTransactionReplacedEventPayload {
  oldHash: string;
  newHash: string;
  from: string;
  nonce: number;
  providerName: string;
}

export class EvmMempoolTransactionReplacedEvent extends BasicEvent<EvmMempoolTransactionReplacedEventPayload> {}
