import { BasicEvent } from '../../../base.event';

interface BitcoinListenerBlocksParsedEventPayload {
  aggregateId: string;
  requestId: string;
  blocks: any;
  status: string;
}

export class BitcoinListenerBlocksParsedEvent implements BasicEvent<BitcoinListenerBlocksParsedEventPayload> {
  constructor(public readonly payload: BitcoinListenerBlocksParsedEventPayload) {}
}
