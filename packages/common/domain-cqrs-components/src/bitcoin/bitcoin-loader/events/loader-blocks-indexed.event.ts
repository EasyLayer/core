import { BasicEvent } from '../../../base.event';

interface BitcoinLoaderBlocksIndexedEventPayload {
  aggregateId: string;
  requestId: string;
  blocks: any;
  status: string;
}

export class BitcoinLoaderBlocksIndexedEvent implements BasicEvent<BitcoinLoaderBlocksIndexedEventPayload> {
  constructor(public readonly payload: BitcoinLoaderBlocksIndexedEventPayload) {}
}
