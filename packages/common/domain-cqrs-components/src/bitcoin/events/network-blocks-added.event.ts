import { BasicEvent } from '../../base.event';

interface BitcoinNetworkBlocksAddedEventPayload {
  aggregateId: string;
  requestId: string;
  blocks: any;
  status: string;
}

export class BitcoinNetworkBlocksAddedEvent implements BasicEvent<BitcoinNetworkBlocksAddedEventPayload> {
  constructor(public readonly payload: BitcoinNetworkBlocksAddedEventPayload) {}
}
