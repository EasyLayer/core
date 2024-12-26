import { BasicEvent } from '../../base.event';

interface BitcoinSchemaUpMigrationStartedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  upQueries: any[];
  downQueries: any[];
}

export class BitcoinSchemaUpMigrationStartedEvent implements BasicEvent<BitcoinSchemaUpMigrationStartedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaUpMigrationStartedEventPayload) {}
}
