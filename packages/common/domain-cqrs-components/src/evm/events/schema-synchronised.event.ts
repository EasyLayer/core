import { BasicEvent } from '../../base.event';

interface EvmSchemaSynchronisedEventPayload {
  aggregateId: string;
  requestId: string;
}

export class EvmSchemaSynchronisedEvent implements BasicEvent<EvmSchemaSynchronisedEventPayload> {
  constructor(public readonly payload: EvmSchemaSynchronisedEventPayload) {}
}
