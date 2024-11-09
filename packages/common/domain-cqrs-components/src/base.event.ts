export interface BasicEvent<T> {
  payload: BasicEventPayload & T;
}

interface BasicEventPayload {
  aggregateId: string;
  requestId?: string;
}
