import 'reflect-metadata';
import { toWireEventRecord } from '../outbox.deserialize';
import { CompressionUtils } from '../compression';

jest.mock('../compression', () => ({
  CompressionUtils: {
    decompressBufferToString: jest.fn(),
  },
}));

describe('toWireEventRecord()', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('reads plain payload buffer without decompression', async () => {
    const row: any = {
      aggregateId: 'M',
      eventType: 'X',
      eventVersion: 1,
      requestId: 'q',
      blockHeight: 2,
      payload: Buffer.from('{"ok":true}', 'utf8'),
      isCompressed: false,
      timestamp: 1,
    };
    const rec = await toWireEventRecord(row);
    expect(rec.modelName).toBe('M');
    expect(rec.eventType).toBe('X');
    expect(rec.eventVersion).toBe(1);
    expect(rec.requestId).toBe('q');
    expect(rec.blockHeight).toBe(2);
    expect(rec.payload).toBe('{"ok":true}');
    expect(rec.timestamp).toBe(1);
    expect(CompressionUtils.decompressBufferToString).not.toHaveBeenCalled();
  });

  it('uses decompress for compressed payload, keeps JSON string', async () => {
    (CompressionUtils.decompressBufferToString as jest.Mock).mockResolvedValue("{'ok':true}");
    const row: any = {
      aggregateId: 'M',
      eventType: 'X',
      eventVersion: 1,
      requestId: 'q',
      blockHeight: 2,
      payload: Buffer.from('X'),
      isCompressed: true,
      timestamp: 1,
    };
    const rec = await toWireEventRecord(row);
    expect(CompressionUtils.decompressBufferToString).toHaveBeenCalled();
    expect(rec.payload).toBe("{'ok':true}");
  });

  it('normalizes null blockHeight to -1', async () => {
    const row: any = {
      aggregateId: 'M',
      eventType: 'X',
      eventVersion: 1,
      requestId: 'q',
      blockHeight: null,
      payload: Buffer.from('{}', 'utf8'),
      isCompressed: false,
      timestamp: 1,
    };
    const rec = await toWireEventRecord(row);
    expect(rec.blockHeight).toBe(-1);
  });
});
