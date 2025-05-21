export type DefaultOutgoingActions = 'event' | 'ping' | 'error' | 'queryResponse' | 'batch';
export type DefaultIncomingActions = 'pong' | 'query';

export interface OutgoingMessage<A extends string = string, P = any> {
  requestId?: string;
  action: A;
  payload?: P;
}

export interface IncomingMessage<A extends string = string, P = any> {
  requestId: string;
  action: A;
  payload?: P;
}
