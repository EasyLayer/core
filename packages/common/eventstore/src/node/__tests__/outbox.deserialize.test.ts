import 'reflect-metadata';
import { deserializeToOutboxRaw } from '../outbox.deserialize';
import { CompressionUtils } from '../../node/compression';

jest.mock('../compression', () => ({
  CompressionUtils: {
    decompressBufferToString: jest.fn(),
  },
}));

describe('deserializeToOutboxRaw()', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('reads plain payload buffer without decompression', async () => {
    const row: any = {
      aggregateId: 'A',
      eventType: 'E',
      eventVersion: 5n as any,
      requestId: 'r',
      blockHeight: 10,
      payload: Buffer.from(JSON.stringify({ a: 1 }), 'utf8'),
      isCompressed: false,
      timestamp: 1234567890123n as any,
    };
    const rec = await deserializeToOutboxRaw(row);
    expect(rec.modelName).toBe('A');
    expect(rec.eventType).toBe('E');
    expect(rec.eventVersion).toBe(5);
    expect(rec.requestId).toBe('r');
    expect(rec.blockHeight).toBe(10);
    expect(typeof rec.payload).toBe('string');
    expect(rec.payload).toBe(row.payload.toString('utf8'));
    expect(rec.timestamp).toBe(Number(row.timestamp));
  });

  it('decompresses when isCompressed is true', async () => {
    (CompressionUtils.decompressBufferToString as jest.Mock).mockResolvedValue("{'ok':true}");
    const row: any = {
      aggregateId: 'M',
      eventType: 'X',
      eventVersion: 2,
      requestId: 'q',
      blockHeight: 7,
      payload: Buffer.from('z'),
      isCompressed: true,
      timestamp: 111,
    };
    const rec = await deserializeToOutboxRaw(row);
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
    const rec = await deserializeToOutboxRaw(row);
    expect(rec.blockHeight).toBe(-1);
  });
});