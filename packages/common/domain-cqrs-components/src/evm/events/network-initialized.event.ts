import { BasicEvent } from '../../base.event';

interface EvmNetworkInitializedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  indexedHeight: string;
}

export class EvmNetworkInitializedEvent implements BasicEvent<EvmNetworkInitializedEventPayload> {
  constructor(public readonly payload: EvmNetworkInitializedEventPayload) {}
}
