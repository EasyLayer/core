import { BasicEvent } from '../../base.event';

interface EvmNetworkReorganisationStartedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  blocks: any[];
  height: string;
}

export class EvmNetworkReorganisationStartedEvent implements BasicEvent<EvmNetworkReorganisationStartedEventPayload> {
  constructor(public readonly payload: EvmNetworkReorganisationStartedEventPayload) {}
}
