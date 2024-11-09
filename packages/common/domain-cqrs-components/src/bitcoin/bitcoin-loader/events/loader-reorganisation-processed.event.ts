import { BasicEvent } from '../../../base.event';

interface BitcoinLoaderReorganisationProcessedEventPayload {
  aggregateId: string;
  requestId: string;
  height: string;
  blocks: any[];
}

export class BitcoinLoaderReorganisationProcessedEvent
  implements BasicEvent<BitcoinLoaderReorganisationProcessedEventPayload>
{
  constructor(public readonly payload: BitcoinLoaderReorganisationProcessedEventPayload) {}
}
