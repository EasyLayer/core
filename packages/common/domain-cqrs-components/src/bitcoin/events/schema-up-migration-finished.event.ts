import { BasicEvent } from '../../base.event';

interface BitcoinSchemaUpMigrationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
}

export class BitcoinSchemaUpMigrationFinishedEvent implements BasicEvent<BitcoinSchemaUpMigrationFinishedEventPayload> {
  constructor(public readonly payload: BitcoinSchemaUpMigrationFinishedEventPayload) {}
}
