export const TRANSPORT_OVERHEAD_WIRE = 256;

export type TransportKind =
  | 'http' // only for node version
  | 'ws' // node + broser same name
  | 'ipc-parent' // only for node version
  | 'ipc-child' // only for node version
  | 'electron-ipc-main' // only for node version
  | 'electron-ipc-renderer'; // only for browser version

export interface Message<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string;
  correlationId?: string;
  clientId?: string;
  timestamp?: number;
}

export type PingPayload = {
  ts: number;
  nonce?: string;
  sid?: string;
};
export type PongPayload = {
  ts: number;
  nonce?: string;
  proof?: string;
  sid?: string;
};

export interface OutboxStreamAckPayload {
  ok: boolean;
  okIndices?: number[];
}

export interface QueryRequestPayload {
  name: string;
  dto?: any;
}
export interface QueryResponsePayload {
  ok: boolean;
  name: string;
  data?: any;
  err?: string;
}

export const Actions = {
  Ping: 'ping',
  Pong: 'pong',
  OutboxStreamBatch: 'outbox.stream.batch',
  OutboxStreamAck: 'outbox.stream.ack',
  QueryRequest: 'query.request',
  QueryResponse: 'query.response',
} as const;

export type ActionsKey = (typeof Actions)[keyof typeof Actions];
