import { BasicEvent } from '../../../base.event';

interface BitcoinListenerReorganisationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  height: string;
  blocks: any;
}

export class BitcoinListenerReorganisationFinishedEvent
  implements BasicEvent<BitcoinListenerReorganisationFinishedEventPayload>
{
  constructor(public readonly payload: BitcoinListenerReorganisationFinishedEventPayload) {}
}
