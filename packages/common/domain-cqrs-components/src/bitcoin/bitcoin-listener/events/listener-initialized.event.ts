import { BasicEvent } from '../../../base.event';

interface BitcoinListenerInitializedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  indexedHeight: string;
}

export class BitcoinListenerInitializedEvent implements BasicEvent<BitcoinListenerInitializedEventPayload> {
  constructor(public readonly payload: BitcoinListenerInitializedEventPayload) {}
}
