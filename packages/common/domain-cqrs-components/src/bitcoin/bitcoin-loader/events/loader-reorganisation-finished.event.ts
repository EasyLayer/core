import { BasicEvent } from '../../../base.event';

interface BitcoinLoaderReorganisationFinishedEventPayload {
  aggregateId: string;
  requestId: string;
  status: string;
  height: string;
  blocks: any;
}

export class BitcoinLoaderReorganisationFinishedEvent
  implements BasicEvent<BitcoinLoaderReorganisationFinishedEventPayload>
{
  constructor(public readonly payload: BitcoinLoaderReorganisationFinishedEventPayload) {}
}
