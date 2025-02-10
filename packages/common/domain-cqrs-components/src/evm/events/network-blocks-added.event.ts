import { BasicEvent } from '../../base.event';

interface EvmNetworkBlocksAddedEventPayload {
  aggregateId: string;
  requestId: string;
  blocks: any;
  status: string;
}

export class EvmNetworkBlocksAddedEvent implements BasicEvent<EvmNetworkBlocksAddedEventPayload> {
  constructor(public readonly payload: EvmNetworkBlocksAddedEventPayload) {}
}
