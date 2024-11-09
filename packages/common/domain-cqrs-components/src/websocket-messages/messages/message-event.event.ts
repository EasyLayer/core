import { BasicMessage } from '../../base.message';

interface WebsocketMessagePayload {
  eventName: string;
  data: any;
}

export class WebsocketMessage implements BasicMessage<WebsocketMessagePayload> {
  constructor(public readonly payload: WebsocketMessagePayload) {}
}
