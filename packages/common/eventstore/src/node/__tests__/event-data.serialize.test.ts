import 'reflect-metadata';
import { toEventDataModel, toDomainEvent, toEventReadRow } from '../event-data.serialize';

jest.mock('../compression', () => ({
  CompressionUtils: {
    shouldCompress: jest.fn(),
    compressToBuffer: jest.fn(),
    decompressBufferToString: jest.fn(),
  },
}));
jest.mock('../bytes', () => ({
  utf8ToBuffer: (s: string) => Buffer.from(s, 'utf8'),
  bufferToUtf8: (b: Buffer) => b.toString('utf8'),
}));

const { CompressionUtils } = jest.requireMock('../compression');

function mkEvent(type: string, payload: any, blockHeight: number, requestId = 'rid', timestamp = 1111): any {
  const proto: any = {};
  Object.defineProperty(proto, 'constructor', { value: { name: type }, enumerable: false });
  return Object.assign(Object.create(proto), {
    aggregateId: 'agg',
    requestId,
    blockHeight,
    timestamp,
    payload,
  });
}

describe('event-data.serialize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('toEventDataModel without compression', async () => {
    CompressionUtils.shouldCompress.mockReturnValue(false);
    const ev = mkEvent('UserCreated', { a: 1 }, 5);
    const row = await toEventDataModel(ev, 3, 'postgres' as any);
    expect(row.type).toBe('UserCreated');
    expect(row.version).toBe(3);
    expect(row.requestId).toBe('rid');
    expect(row.blockHeight).toBe(5);
    expect(row.isCompressed).toBe(false);
    expect(row.timestamp).toBe(1111);
    expect(Buffer.isBuffer(row.payload)).toBe(true);
    expect(row.payload.toString('utf8')).toBe(JSON.stringify({ a: 1 }));
  });

  // it('toEventDataModel with compression', async () => {
  //   CompressionUtils.shouldCompress.mockReturnValue(true);
  //   CompressionUtils.compressToBuffer.mockResolvedValue(Buffer.from('zzz'));
  //   const ev = mkEvent('X', { k: 2 }, 7);
  //   const row = await toEventDataModel(ev, 2, 'postgres' as any);
  //   expect(row.isCompressed).toBe(true);
  //   expect(row.payload).toEqual(Buffer.from('zzz'));
  // });

  it('toDomainEvent reconstructs event prototype and parses payload', async () => {
    CompressionUtils.decompressBufferToString.mockReset();
    const model = {
      type: 'OrderPlaced',
      requestId: 'r1',
      blockHeight: null,
      payload: Buffer.from(JSON.stringify({ p: 10 })),
      isCompressed: false,
      version: 4,
      timestamp: 2222,
    } as any;
    const ev = await toDomainEvent('agg1', model, 'postgres' as any);
    expect(ev.aggregateId).toBe('agg1');
    expect(ev.requestId).toBe('r1');
    expect(ev.blockHeight).toBe(-1);
    expect(ev.timestamp).toBe(2222);
    expect(ev.payload).toEqual({ p: 10 });
    expect((ev as any).constructor.name).toBe('OrderPlaced');
  });

  it('toDomainEvent handles compressed payload', async () => {
    CompressionUtils.decompressBufferToString.mockResolvedValue(JSON.stringify({ z: 3 }));
    const model = {
      type: 'Ev',
      requestId: 'r2',
      blockHeight: 9,
      payload: Buffer.from('abc'),
      isCompressed: true,
      version: 1,
      timestamp: 3333,
    } as any;
    const ev = await toDomainEvent('agg2', model, 'postgres' as any);
    expect(ev.blockHeight).toBe(9);
    expect(ev.payload).toEqual({ z: 3 });
  });

  it('toEventReadRow returns JSON string payload', async () => {
    const model = {
      type: 'T',
      requestId: 'r3',
      blockHeight: null,
      payload: Buffer.from(JSON.stringify({ q: 1 })),
      isCompressed: false,
      version: 5,
      timestamp: 4444,
    } as any;
    const row = await toEventReadRow('modelA', model, 'postgres' as any);
    expect(row.modelId).toBe('modelA');
    expect(row.eventType).toBe('T');
    expect(row.eventVersion).toBe(5);
    expect(row.requestId).toBe('r3');
    expect(row.blockHeight).toBe(-1);
    expect(row.payload).toBe(JSON.stringify({ q: 1 }));
    expect(row.timestamp).toBe(4444);
  });

  it('toEventReadRow handles compressed', async () => {
    CompressionUtils.decompressBufferToString.mockResolvedValue(JSON.stringify({ a: 2 }));
    const model = {
      type: 'T2',
      requestId: 'r4',
      blockHeight: 3,
      payload: Buffer.from('x'),
      isCompressed: true,
      version: 6,
      timestamp: 5555,
    } as any;
    const row = await toEventReadRow('M', model, 'postgres' as any);
    expect(row.blockHeight).toBe(3);
    expect(row.payload).toBe(JSON.stringify({ a: 2 }));
  });
});
