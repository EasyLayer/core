import { BasicEvent } from '../../../base.event';

interface BitcoinLoaderReorganisationStartedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  blocks: any[];
  height: string;
}

export class BitcoinLoaderReorganisationStartedEvent
  implements BasicEvent<BitcoinLoaderReorganisationStartedEventPayload>
{
  constructor(public readonly payload: BitcoinLoaderReorganisationStartedEventPayload) {}
}
