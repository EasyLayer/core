import { BasicEvent } from '../../base.event';

interface BitcoinNetworkReorganisationProcessedEventPayload {
  aggregateId: string;
  requestId: string;
  height: string;
  blocks: any[];
}

export class BitcoinNetworkReorganisationProcessedEvent
  implements BasicEvent<BitcoinNetworkReorganisationProcessedEventPayload>
{
  constructor(public readonly payload: BitcoinNetworkReorganisationProcessedEventPayload) {}
}
