export const TRANSPORT_OVERHEAD_WIRE = 256;

export interface Envelope<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string;
  correlationId?: string;
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

export type RegisterStreamConsumerPayload = { token?: string };

export interface WireEventRecord {
  modelName: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number | null;
  payload: string;
  timestamp: number;
}

export interface OutboxStreamBatchPayload {
  events: WireEventRecord[];
}
export interface OutboxStreamAckPayload {
  allOk: boolean;
  okIndices?: number[];
}

export interface QueryRequestPayload {
  name: string;
  dto?: any;
}
export interface QueryResponsePayload {
  name: string;
  data?: any;
  err?: string;
}

export const Actions = {
  Ping: 'ping',
  Pong: 'pong',

  RegisterStreamConsumer: 'registerStreamConsumer',

  OutboxStreamBatch: 'outboxStreamBatch',
  OutboxStreamAck: 'outboxStreamAck',

  QueryRequest: 'query.request',
  QueryResponse: 'query.response',

  Error: 'error',
} as const;

export type ActionsKey = (typeof Actions)[keyof typeof Actions];
