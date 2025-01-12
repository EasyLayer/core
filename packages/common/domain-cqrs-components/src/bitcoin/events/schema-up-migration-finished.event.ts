import { BasicEvent } from '../../base.event';

interface BitcoinSchemaUpMigrationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  upQueries: any[];
}

export class BitcoinSchemaUpMigrationFinishedEvent implements BasicEvent<BitcoinSchemaUpMigrationFinishedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaUpMigrationFinishedEventPayload) {}
}
