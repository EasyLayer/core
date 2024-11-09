import { BasicEvent } from '../../../base.event';

interface BitcoinIndexerReorganisationProcessedEventPayload {
  aggregateId: string;
  requestId: string;
  height: string;
  blocks: any[];
}

export class BitcoinIndexerReorganisationProcessedEvent
  implements BasicEvent<BitcoinIndexerReorganisationProcessedEventPayload>
{
  constructor(public readonly payload: BitcoinIndexerReorganisationProcessedEventPayload) {}
}
