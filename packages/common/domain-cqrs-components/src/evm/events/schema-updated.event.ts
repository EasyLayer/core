import { BasicEvent } from '../../base.event';

interface EvmSchemaUpdatedEventPayload {
  aggregateId: string;
  requestId: string;
  upQueries: any[];
  downQueries: any[];
}

export class EvmSchemaUpdatedEvent implements BasicEvent<EvmSchemaUpdatedEventPayload> {
  constructor(public readonly payload: EvmSchemaUpdatedEventPayload) {}
}
