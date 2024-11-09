import { BasicEvent } from '../../../base.event';

interface BitcoinIndexerReorganisationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  height: string;
  blocks: any;
}

export class BitcoinIndexerReorganisationFinishedEvent
  implements BasicEvent<BitcoinIndexerReorganisationFinishedEventPayload>
{
  constructor(public readonly payload: BitcoinIndexerReorganisationFinishedEventPayload) {}
}
