import "reflect-metadata";
import { createEventDataEntity, serializeEventRow, deserializeToDomainEvent } from "../event-data.model";
import { CompressionUtils } from "../compression";

jest.mock("../compression", () => ({
  CompressionUtils: {
    shouldCompress: jest.fn(),
    compressToBuffer: jest.fn(),
    decompressBufferToString: jest.fn(),
  },
}));

function mkEvent(type: string, payload: any, blockHeight: number, requestId = "rid", timestamp = Date.now()): any {
  const proto: any = {};
  Object.defineProperty(proto, "constructor", { value: { name: type }, enumerable: false });
  return Object.assign(Object.create(proto), {
    aggregateId: "agg",
    requestId,
    blockHeight,
    timestamp,
    payload,
  });
}

describe("createEventDataEntity()", () => {
  it("postgres types and flags", () => {
    const s = createEventDataEntity("agg_ev", "postgres") as any;
    const c = s.options.columns;
    expect(c.id.type).toBe("bigserial");
    expect(c.id.generated).toBe(true);
    expect(c.payload.type).toBe("bytea");
    expect(c.blockHeight.nullable).toBe(true);
    expect(c.blockHeight.default).toBeNull();
    const uniques = s.options.uniques[0];
    const indices = s.options.indices[0];
    expect(uniques.columns).toEqual(["version", "requestId"]);
    expect(indices.columns).toEqual(["blockHeight"]);
  });

  it("sqlite types and flags", () => {
    const s = createEventDataEntity("agg_ev", "sqlite") as any;
    const c = s.options.columns;
    expect(c.id.type).toBe("integer");
    expect(c.id.generated).toBe("increment");
    expect(c.payload.type).toBe("blob");
  });
});

describe("serializeEventRow()", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("postgres: compresses when beneficial (isCompressed true, buffer is compressed, size meta correct)", async () => {
    const json = JSON.stringify({ v: "x".repeat(4000) });
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    (CompressionUtils.compressToBuffer as jest.Mock).mockResolvedValue({
      buffer: Buffer.from("COMPRESSED"),
      originalSize: Buffer.byteLength(json, "utf8"),
      compressedSize: Math.floor(Buffer.byteLength(json, "utf8") * 0.5),
      ratio: 2,
    });

    const ev = mkEvent("Evt", JSON.parse(json), 7);
    const row = await serializeEventRow(ev, 3, "postgres");

    expect(row.type).toBe("Evt");
    expect(row.version).toBe(3);
    expect(row.requestId).toBe("rid");
    expect(row.blockHeight).toBe(7);
    expect(row.isCompressed).toBe(true);
    expect(row.payload.equals(Buffer.from("COMPRESSED"))).toBe(true);
    expect(row.payloadUncompressedBytes).toBe(Buffer.byteLength(json, "utf8"));
  });

  it("postgres: falls back to plain bytes when compression not beneficial", async () => {
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    (CompressionUtils.compressToBuffer as jest.Mock).mockResolvedValue({
      buffer: Buffer.from("DONT_USE"),
      originalSize: 1000,
      compressedSize: 950, // 95% => not < 90%
      ratio: 1.05,
    });

    const payload = { a: 1, b: "y" };
    const json = JSON.stringify(payload);
    const ev = mkEvent("Evt", payload, 1);
    const row = await serializeEventRow(ev, 1, "postgres");

    expect(row.isCompressed).toBe(false);
    expect(row.payload.equals(Buffer.from(json, "utf8"))).toBe(true);
  });

  it("sqlite: never compresses even if shouldCompress true", async () => {
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(true);
    const payload = { a: "z".repeat(3000) };
    const json = JSON.stringify(payload);
    const ev = mkEvent("Evt", payload, 5);
    const row = await serializeEventRow(ev, 2, "sqlite");

    expect(row.isCompressed).toBe(false);
    expect(row.payload.equals(Buffer.from(json, "utf8"))).toBe(true);
  });

  it("normalizes blockHeight -1 to null", async () => {
    const ev = mkEvent("Evt", { k: 1 }, -1);
    (CompressionUtils.shouldCompress as jest.Mock).mockReturnValue(false);
    const row = await serializeEventRow(ev, 0, "postgres");
    expect(row.blockHeight).toBeNull();
  });

  it("throws on missing requestId/version/blockHeight/timestamp", async () => {
    const base = { payload: {}, blockHeight: 1, requestId: "rid", timestamp: Date.now() };
    await expect(serializeEventRow({ ...base, requestId: "" } as any, 1, "postgres")).rejects.toThrow(/Request Id/);
    await expect(serializeEventRow({ ...base } as any, null as any, "postgres")).rejects.toThrow(/Version/);
    await expect(serializeEventRow({ ...base, blockHeight: null } as any, 1, "postgres")).rejects.toThrow(/blockHeight/);
    await expect(serializeEventRow({ ...base, timestamp: 0 } as any, 1, "postgres")).rejects.toThrow(/timestamp/);
  });
});

describe("deserializeToDomainEvent()", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("reads plain buffer, restores constructor.name and payload, null height -> -1", async () => {
    const payload = { a: 1, b: "c" };
    const json = JSON.stringify(payload);
    const row = {
      type: "Evt",
      requestId: "rid",
      blockHeight: null,
      payload: Buffer.from(json, "utf8"),
      isCompressed: false,
      version: 3,
      timestamp: 111,
    };

    const ev = await deserializeToDomainEvent("agg", row as any, "postgres");
    expect(ev.aggregateId).toBe("agg");
    expect(ev.requestId).toBe("rid");
    expect(ev.blockHeight).toBe(-1);
    expect(ev.timestamp).toBe(111);
    expect(ev.constructor.name).toBe("Evt");
    expect(ev.payload).toEqual(payload);
  });

  it("reads compressed buffer using decompressBufferToString", async () => {
    (CompressionUtils.decompressBufferToString as jest.Mock).mockResolvedValue(JSON.stringify({ ok: true }));
    const row = {
      type: "Evt",
      requestId: "rid",
      blockHeight: 9,
      payload: Buffer.from("X"),
      isCompressed: true,
      version: 1,
      timestamp: 222,
    };

    const ev = await deserializeToDomainEvent("agg", row as any, "postgres");
    expect(ev.blockHeight).toBe(9);
    expect(ev.payload).toEqual({ ok: true });
    expect(ev.constructor.name).toBe("Evt");
  });
});
