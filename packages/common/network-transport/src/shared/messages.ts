import { MessageSizeError } from './errors';

export interface BasePayload<DTO = any> {
  constructorName: string;
  dto: DTO;
}

export interface BaseMessage<A extends string = string, P = any> {
  requestId?: string;
  action: A;
  payload?: P;
  timestamp?: number;
}

// ===== Actions =====
// Incoming (client -> server)
export type IncomingActions =
  | 'query'
  // 'streamQuery' is optional; enable it via transport options
  | 'streamQuery'
  | 'ping'
  | 'pong'
  | 'outboxStreamAck' // ACK for outbox batches
  | 'secureHello' // IPC DH handshake start
  | 'secureAck'; // IPC handshake finalized

// Outgoing (server -> client)
export type OutgoingActions =
  | 'queryResponse'
  | 'streamResponse'
  | 'streamEnd'
  | 'error'
  | 'ping'
  | 'pong'
  | 'outboxStreamBatch' // batch of outbox events
  | 'secureKey'; // IPC server key during handshake

export interface IncomingMessage<A extends IncomingActions = IncomingActions, P = any> extends BaseMessage<A, P> {}
export interface OutgoingMessage<A extends OutgoingActions = OutgoingActions, P = any> extends BaseMessage<A, P> {}

// ===== Wire records =====

export interface WireEventRecord {
  /** Business model name the client understands */
  modelName: string;
  /** Event constructor name */
  eventType: string;
  /** Version within aggregate */
  eventVersion: number;
  requestId: string;
  blockHeight: number;
  /** Serialized JSON string (already decompressed if DB compressed it) */
  payload: string;
  /** Milliseconds since epoch for ordering/telemetry */
  timestamp: number;
}

// Batch meta & ACK
export interface OutboxStreamBatchPayload {
  batchId: string;
  events: WireEventRecord[];
}

export interface OutboxStreamAckPayload {
  batchId: string;
  allOk?: boolean;
  /** If partial success: indices of ok events relative to sent batch order */
  okIndices?: number[];
  /** For HTTP/webhook: when it's easier to ack by key instead of index */
  okKeys?: Array<{ modelName: string; eventVersion: number }>;
}

export type OutboxStreamBatchMessage = OutgoingMessage<'outboxStreamBatch', OutboxStreamBatchPayload>;
export type OutboxStreamAckMessage = IncomingMessage<'outboxStreamAck', OutboxStreamAckPayload>;

// Aliases if you prefer naming as "events"
export type EventsBatchMessage = OutboxStreamBatchMessage;
export type EventsAckMessage = OutboxStreamAckMessage;

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_WS_PORT = 3001;

// Message size limits per transport
export const MESSAGE_SIZE_LIMITS = {
  IPC: 1 * 1024 * 1024, // 1MB for IPC
  WS: 10 * 1024 * 1024, // 10MB for WebSocket
  HTTP: 100 * 1024 * 1024, // 100MB for HTTP
};

export const validateMessageSize = (data: any, maxSize: number, transportType: string): void => {
  const serialized = JSON.stringify(data);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > maxSize) {
    throw new MessageSizeError(`Message size ${size} bytes exceeds limit of ${maxSize} bytes`, size, maxSize, {
      transportType,
    });
  }
};
