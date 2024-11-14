import { BasicEvent } from '../../base.event';

interface BitcoinNetworkReorganisationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  height: string;
  blocks: any;
}

export class BitcoinNetworkReorganisationFinishedEvent
  implements BasicEvent<BitcoinNetworkReorganisationFinishedEventPayload>
{
  constructor(public readonly payload: BitcoinNetworkReorganisationFinishedEventPayload) {}
}
