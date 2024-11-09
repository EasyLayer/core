export interface BasicMessage<T> {
  payload: BasicMessagePayload & T;
}

interface BasicMessagePayload {
  eventName: string;
  data: any;
}
