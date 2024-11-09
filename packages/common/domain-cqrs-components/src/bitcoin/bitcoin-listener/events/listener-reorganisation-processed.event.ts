import { BasicEvent } from '../../../base.event';

interface BitcoinListenerReorganisationProcessedEventPayload {
  aggregateId: string;
  requestId: string;
  height: string;
  blocks: any[];
}

export class BitcoinListenerReorganisationProcessedEvent
  implements BasicEvent<BitcoinListenerReorganisationProcessedEventPayload>
{
  constructor(public readonly payload: BitcoinListenerReorganisationProcessedEventPayload) {}
}
