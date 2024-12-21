import { BasicEvent } from '../../base.event';

interface BitcoinSchemaUpMigrationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  upQueries: any[];
  downQueries: string[];
}

export class BitcoinSchemaUpMigrationFinishedEvent implements BasicEvent<BitcoinSchemaUpMigrationFinishedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaUpMigrationFinishedEventPayload) {}
}
