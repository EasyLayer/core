import { BasicEvent } from '../../base.event';

interface EvmNetworkReorganisationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  height: string;
  blocks: any;
}

export class EvmNetworkReorganisationFinishedEvent implements BasicEvent<EvmNetworkReorganisationFinishedEventPayload> {
  constructor(public readonly payload: EvmNetworkReorganisationFinishedEventPayload) {}
}
