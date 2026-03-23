// Interfaces only — no TypeORM imports.
// TypeORM entity factory is in src/node/entities.ts

export interface SnapshotReadRow {
  modelId: string;
  blockHeight: number;
  version: number;
  payload: string; // JSON string
}

export interface SnapshotDataModel {
  id?: string;
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: Buffer;
  isCompressed?: boolean;
  createdAt: string;
}

export interface SnapshotParsedPayload extends SnapshotDataModel {
  payload: any;
}
