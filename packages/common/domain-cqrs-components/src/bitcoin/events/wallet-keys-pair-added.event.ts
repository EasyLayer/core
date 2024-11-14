import { BasicEvent } from '../../base.event';

interface BitcoinWalletKeysPairAddedEventPayload {
  aggregateId: string;
  requestId: string;
  publicKeyHash: string;
}

export class BitcoinWalletKeysPairAddedEvent implements BasicEvent<BitcoinWalletKeysPairAddedEventPayload> {
  constructor(public readonly payload: BitcoinWalletKeysPairAddedEventPayload) {}
}
