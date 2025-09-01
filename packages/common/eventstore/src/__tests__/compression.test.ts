import "reflect-metadata";
import { CompressionUtils } from "../compression";

describe("CompressionUtils", () => {
  it("compress/decompress roundtrip works and reports sizes", async () => {
    const src = "x".repeat(5000);
    const comp = await CompressionUtils.compressToBuffer(src);
    const out = await CompressionUtils.decompressBufferToString(comp.buffer);
    expect(out).toBe(src);
    expect(comp.originalSize).toBe(Buffer.from(src, "utf8").length);
    expect(comp.compressedSize).toBeLessThan(comp.originalSize);
    expect(comp.ratio).toBeGreaterThan(1);
  });

  it("shouldCompress respects threshold", () => {
    expect(CompressionUtils.shouldCompress("a".repeat(10), 100)).toBe(false);
    expect(CompressionUtils.shouldCompress("a".repeat(200), 100)).toBe(true);
  });

  it("decompressAny handles Buffer, base64 and plain string", async () => {
    const src = JSON.stringify({ a: 1, b: "zz" });
    const comp = await CompressionUtils.compressToBuffer(src);
    const bufOut = await CompressionUtils.decompressAny(comp.buffer);
    expect(bufOut).toBe(src);
    const b64 = comp.buffer.toString("base64");
    const b64Out = await CompressionUtils.decompressAny(b64);
    expect(b64Out).toBe(src);
    const plain = await CompressionUtils.decompressAny(src);
    expect(plain).toBe(src);
  });
});
