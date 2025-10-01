export interface WireEventRecord {
  /** Business model name that the client understands (was aggregateId/table name) */
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
