import { BasicEvent } from '../../../base.event';

interface BitcoinIndexerBlocksIndexedEventPayload {
  aggregateId: string;
  requestId: string;
  blocks: any;
  status: string;
}

export class BitcoinIndexerBlocksIndexedEvent implements BasicEvent<BitcoinIndexerBlocksIndexedEventPayload> {
  constructor(public readonly payload: BitcoinIndexerBlocksIndexedEventPayload) {}
}
