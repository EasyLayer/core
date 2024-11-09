import { BasicEvent } from '../../../base.event';

interface BitcoinIndexerInitializedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  indexedHeight: string;
}

export class BitcoinIndexerInitializedEvent implements BasicEvent<BitcoinIndexerInitializedEventPayload> {
  constructor(public readonly payload: BitcoinIndexerInitializedEventPayload) {}
}
