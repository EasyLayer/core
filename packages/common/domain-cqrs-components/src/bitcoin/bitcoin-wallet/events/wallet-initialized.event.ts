import { BasicEvent } from '../../../base.event';

interface BitcoinWalletInitializedEventPayload {
  aggregateId: string;
  requestId: string;
  publicKeyHashes: string[];
}

export class BitcoinWalletInitializedEvent implements BasicEvent<BitcoinWalletInitializedEventPayload> {
  constructor(public readonly payload: BitcoinWalletInitializedEventPayload) {}
}
