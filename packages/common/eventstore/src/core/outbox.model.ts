// Interface only — no TypeORM imports.
// TypeORM entity factory is in src/node/entities.ts

export interface OutboxDataModel {
  id: string | number;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number;
  payload: Buffer;
  timestamp: number;
  isCompressed?: boolean;
  uncompressedBytes: number;
}
