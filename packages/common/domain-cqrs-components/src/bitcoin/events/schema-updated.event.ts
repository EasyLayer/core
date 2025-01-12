import { BasicEvent } from '../../base.event';

interface BitcoinSchemaUpdatedEventPayload {
  aggregateId: string;
  requestId: string;
  upQueries: any[];
  downQueries: any[];
}

export class BitcoinSchemaUpdatedEvent implements BasicEvent<BitcoinSchemaUpdatedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaUpdatedEventPayload) {}
}
