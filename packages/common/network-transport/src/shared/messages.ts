export const TRANSPORT_OVERHEAD_WIRE = 256; // keep as MAX envelope overhead across transports

// Generic envelope
export interface Envelope<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string; // per-event idempotency (your current contract)
  correlationId?: string; // request/response pairing (IPC strict ACK / RPC)
  timestamp?: number; // producer time (ms)
}

// Ping/Pong
export type PingPayload = { ts: number };
export type PongPayload = { ts: number };

// Stream registration
export type RegisterStreamConsumerPayload = { token?: string };

// Outbox streaming
export interface WireEventRecord {
  modelName: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number | null;
  payload: string; // decompressed JSON string (current contract)
  timestamp: number;
}

export interface OutboxStreamBatchPayload {
  events: WireEventRecord[];
}

export interface OutboxStreamAckPayload {
  allOk: boolean;
  okIndices?: number[];
}

// RPC
export interface RpcRequestPayload {
  route: string;
  data?: any;
}
export interface RpcResponsePayload {
  route: string;
  data?: any;
  err?: string;
}

// Actions
export const Actions = {
  Ping: 'ping',
  Pong: 'pong',

  RegisterStreamConsumer: 'registerStreamConsumer',

  OutboxStreamBatch: 'outboxStreamBatch',
  OutboxStreamAck: 'outboxStreamAck',

  RpcRequest: 'rpc.request',
  RpcResponse: 'rpc.response',

  Error: 'error',
} as const;

export type ActionsKey = (typeof Actions)[keyof typeof Actions];
