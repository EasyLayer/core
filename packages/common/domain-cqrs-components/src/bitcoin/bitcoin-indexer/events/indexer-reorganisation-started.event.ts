import { BasicEvent } from '../../../base.event';

interface BitcoinIndexerReorganisationStartedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  blocks: any[];
  height: string;
}

export class BitcoinIndexerReorganisationStartedEvent
  implements BasicEvent<BitcoinIndexerReorganisationStartedEventPayload>
{
  constructor(public readonly payload: BitcoinIndexerReorganisationStartedEventPayload) {}
}
