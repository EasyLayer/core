import { BasicEvent } from '../../base.event';

interface BitcoinSchemaSynchronisedEventPayload {
  aggregateId: string;
  requestId: string;
}

export class BitcoinSchemaSynchronisedEvent implements BasicEvent<BitcoinSchemaSynchronisedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaSynchronisedEventPayload) {}
}
