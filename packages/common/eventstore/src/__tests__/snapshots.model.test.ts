import "reflect-metadata";
import { createSnapshotsEntity, deserializeSnapshot, serializeSnapshot } from "../snapshots.model";
import { CompressionUtils } from "../compression";

jest.mock("../compression", () => ({
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
  toSnapshot() {
    return this.snap;
  }
}

describe("createSnapshotsEntity()", () => {
  it("postgres mapping", () => {
    const s = createSnapshotsEntity("postgres") as any;
    const c = s.options.columns;
    expect(c.id.type).toBe("bigserial");
    expect(c.id.primary).toBe(true);
    expect(c.id.generated).toBe(true);
    expect(c.payload.type).toBe("bytea");
    expect(c.createdAt.type).toBe("timestamp");
    expect(c.isCompressed.type).toBe("boolean");
    expect(c.isCompressed.default).toBe(false);
    expect(c.isCompressed.nullable).toBe(true);
    expect(s.options.uniques[0].columns).toEqual(["aggregateId", "blockHeight"]);
    expect(s.options.indices.map((i: any) => i.columns)).toEqual(
      expect.arrayContaining([["aggregateId", "blockHeight"], ["blockHeight"], ["createdAt"]])
    );
  });

  it("sqlite mapping", () => {
    const s = createSnapshotsEntity("sqlite") as any;
    const c = s.options.columns;
    expect(c.id.type).toBe("integer");
    expect(c.id.generated).toBe("increment");
    expect(c.payload.type).toBe("blob");
    expect(c.createdAt.type).toBe("datetime");
  });
});

describe("deserializeSnapshot()", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("reads plain buffer, parses payload", async () => {
    const payload = { a: 1, b: "x" };
    const row: any = {
      id: "1",
      aggregateId: "agg",
      blockHeight: 10,
      version: 3,
      payload: Buffer.from(JSON.stringify(payload), "utf8"),
      isCompressed: false,
      createdAt: new Date(),
    };
    const out = await deserializeSnapshot(row, "postgres");
    expect(out.aggregateId).toBe("agg");
    expect(out.blockHeight).toBe(10);
    expect(out.version).toBe(3);
    expect(out.payload).toEqual(payload);
  });

  it("uses decompress when isCompressed is true", async () => {
    const json = JSON.stringify({ ok: true });
    (CompressionUtils.decompressBufferToString as jest.Mock).mockResolvedValue(json);
    const row: any = {
      id: "1",
      aggregateId: "agg",
      blockHeight: 5,
      version: 2,
      payload: Buffer.from("Z"),
      isCompressed: true,
      createdAt: new Date(),
    };
    const out = await deserializeSnapshot(row, "postgres");
    expect(CompressionUtils.decompressBufferToString).toHaveBeenCalled();
    expect(out.payload).toEqual({ ok: true });
  });
});

describe("serializeSnapshot()", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("sqlite: stores plain utf8, no compression", async () => {
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    const a = new Agg("a1", 42, 7, JSON.stringify({ v: "x".repeat(3000) }));
    const row = await serializeSnapshot(a as any, "sqlite");
    expect(row.aggregateId).toBe("a1");
    expect(row.blockHeight).toBe(42);
    expect(row.version).toBe(7);
    expect(row.isCompressed).toBe(false);
    expect(row.payload.equals(Buffer.from(a.toSnapshot(), "utf8"))).toBe(true);
  });

  it("postgres: compresses only if beneficial", async () => {
    const json = JSON.stringify({ v: "y".repeat(4000) });
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    (CompressionUtils.compressToBuffer as jest.Mock).mockResolvedValue({
      buffer: Buffer.from("COMPRESSED"),
      originalSize: Buffer.byteLength(json, "utf8"),
      compressedSize: Math.floor(Buffer.byteLength(json, "utf8") * 0.5),
      ratio: 2,
    });
    const a = new Agg("a1", 1, 2, json);
    const row = await serializeSnapshot(a as any, "postgres");
    expect(row.isCompressed).toBe(true);
    expect(row.payload.equals(Buffer.from("COMPRESSED"))).toBe(true);
  });

  it("postgres: falls back to plain utf8 when not beneficial", async () => {
    const payload = { v: "short" };
    const json = JSON.stringify(payload);
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    (CompressionUtils.compressToBuffer as jest.Mock).mockResolvedValue({
      buffer: Buffer.from("NOPE"),
      originalSize: Buffer.byteLength(json, "utf8"),
      compressedSize: Math.floor(Buffer.byteLength(json, "utf8") * 0.95),
      ratio: 1.05,
    });
    const a = new Agg("a1", 2, 3, json);
    const row = await serializeSnapshot(a as any, "postgres");
    expect(row.isCompressed).toBe(false);
    expect(row.payload.equals(Buffer.from(json, "utf8"))).toBe(true);
  });

  it("validates required fields", async () => {
    const good = new Agg("a1", 1, 1, "{}");
    await expect(serializeSnapshot({ ...good, aggregateId: "" } as any, "postgres")).rejects.toThrow(/aggregate Id/);
    await expect(serializeSnapshot({ ...good, lastBlockHeight: null } as any, "postgres")).rejects.toThrow(/lastBlockHeight/);
    await expect(serializeSnapshot({ ...good, version: null } as any, "postgres")).rejects.toThrow(/version/);
  });
});
