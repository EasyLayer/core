import 'reflect-metadata';
import { toSnapshotDataModel, toSnapshotParsedPayload, toSnapshotReadRow } from '../snapshot.serialize';
import { CompressionUtils } from '../compression';

jest.mock('../compression', () => ({
  CompressionUtils: {
    shouldCompress: jest.fn(),
    compressToBuffer: jest.fn(),
    decompressBufferToString: jest.fn(),
  },
}));

class Agg {
  constructor(
    public aggregateId: string,
    public lastBlockHeight: number,
    public version: number,
    private snap: string
  ) {}
  toSnapshot() { return this.snap; }
}

describe('snapshot.serialize', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('sqlite: stores plain utf8, no compression', async () => {
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    const a = new Agg('a1', 42, 7, JSON.stringify({ v: 'x'.repeat(3000) }));
    const row = await toSnapshotDataModel(a as any, 'sqlite');
    expect(row.aggregateId).toBe('a1');
    expect(row.blockHeight).toBe(42);
    expect(row.version).toBe(7);
    expect(row.isCompressed).toBe(false);
    expect(row.payload.equals(Buffer.from(a.toSnapshot(), 'utf8'))).toBe(true);
  });

  it('postgres: compresses when beneficial', async () => {
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    (CompressionUtils.compressToBuffer as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('ZIP'),
      originalSize: 6000,
      compressedSize: 3000,
      ratio: 2,
    });
    const json = JSON.stringify({ v: 'x'.repeat(6000) });
    const a = new Agg('a1', 2, 3, json);
    const row = await toSnapshotDataModel(a as any, 'postgres');
    expect(row.isCompressed).toBe(true);
    expect(row.payload.equals(Buffer.from('ZIP'))).toBe(true);
  });

  it('postgres: stores plain when not beneficial', async () => {
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(false);
    const json = JSON.stringify({ v: 'x'.repeat(6000) });
    const a = new Agg('a1', 2, 3, json);
    const row = await toSnapshotDataModel(a as any, 'postgres');
    expect(row.isCompressed).toBe(false);
    expect(row.payload.equals(Buffer.from(json, 'utf8'))).toBe(true);
  });

  it('toSnapshotParsedPayload parses JSON and passes driver', async () => {
    const payload = JSON.stringify({ a: 1 });
    const row: any = { payload: Buffer.from(payload, 'utf8'), isCompressed: false, aggregateId: 'a', blockHeight: 1, version: 1 };
    const parsed = await toSnapshotParsedPayload(row, 'postgres');
    expect(parsed.aggregateId).toBe('a');
    expect(parsed.payload).toEqual({ a: 1 });
  });

  it('toSnapshotReadRow returns read DTO from aggregate', async () => {
    const a = new Agg('a1', 10, 2, '{"x":1}');
    const dto = await toSnapshotReadRow(a as any);
    expect(dto.modelId).toBe('a1');
    expect(dto.blockHeight).toBe(10);
    expect(dto.version).toBe(2);
    expect(typeof dto.payload).toBe('string');
  });

  it('validates required fields', async () => {
    const good = new Agg('a1', 1, 1, '{}');
    await expect(toSnapshotDataModel({ ...good, aggregateId: '' } as any, 'postgres')).rejects.toThrow(/aggregate Id/);
    await expect(toSnapshotDataModel({ ...good, lastBlockHeight: null } as any, 'postgres')).rejects.toThrow(/lastBlockHeight/);
    await expect(toSnapshotDataModel({ ...good, version: null } as any, 'postgres')).rejects.toThrow(/version/);
  });
});
