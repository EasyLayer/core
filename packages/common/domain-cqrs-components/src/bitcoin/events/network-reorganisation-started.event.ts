import { BasicEvent } from '../../base.event';

interface BitcoinNetworkReorganisationStartedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  blocks: any[];
  height: string;
}

export class BitcoinNetworkReorganisationStartedEvent
  implements BasicEvent<BitcoinNetworkReorganisationStartedEventPayload>
{
  constructor(public readonly payload: BitcoinNetworkReorganisationStartedEventPayload) {}
}
