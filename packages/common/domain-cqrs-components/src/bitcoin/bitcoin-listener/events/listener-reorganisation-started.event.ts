import { BasicEvent } from '../../../base.event';

interface BitcoinListenerReorganisationStartedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  blocks: any[];
  height: string;
}

export class BitcoinListenerReorganisationStartedEvent
  implements BasicEvent<BitcoinListenerReorganisationStartedEventPayload>
{
  constructor(public readonly payload: BitcoinListenerReorganisationStartedEventPayload) {}
}
