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

export const TRANSPORT_OVERHEAD = {
  IPC: 512, // IPC channel overhead
  WS: 1024, // WebSocket frame headers
  HTTP: 2048, // HTTP headers + chunked encoding
  WIRE: 256, // Base wire protocol overhead
};

export const validateMessageSize = (data: any, maxSize: number, transportType: string): void => {
  const serialized = JSON.stringify(data);
  const baseSize = Buffer.byteLength(serialized, 'utf8');
  const overhead = TRANSPORT_OVERHEAD[transportType.toUpperCase() as keyof typeof TRANSPORT_OVERHEAD] || 0;
  const totalSize = baseSize + overhead;

  if (totalSize > maxSize) {
    const error = new MessageSizeError(
      `Message size ${baseSize} bytes + ${overhead} overhead = ${totalSize} bytes exceeds limit of ${maxSize} bytes for ${transportType}`,
      totalSize,
      maxSize,
      {
        transportType,
        payloadSize: baseSize,
        overhead,
        messageType: data?.action || 'unknown',
        // Add helpful debugging info
        ...(data?.payload?.events && { eventCount: data.payload.events.length }),
      }
    );
    throw error;
  }
};
