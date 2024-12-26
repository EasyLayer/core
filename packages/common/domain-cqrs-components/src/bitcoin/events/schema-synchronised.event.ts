import { BasicEvent } from '../../base.event';

interface BitcoinSchemaSynchronisedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
}

export class BitcoinSchemaSynchronisedEvent implements BasicEvent<BitcoinSchemaSynchronisedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaSynchronisedEventPayload) {}
}
