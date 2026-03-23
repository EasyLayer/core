// Interfaces only — no TypeORM imports.
// TypeORM entity factory is in src/node/entities.ts

export interface EventReadRow {
  modelId: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number;
  payload: string; // JSON string
  timestamp: number;
}

export interface EventDataModel {
  id?: number;
  type: string;
  payload: Buffer;
  version: number;
  requestId: string;
  blockHeight: number;
  timestamp: number;
  isCompressed?: boolean;
  uncompressedBytes?: number;
}
