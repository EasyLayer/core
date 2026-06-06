import { Buffer } from 'buffer';
import { extractRawBlockHeaderMetadata } from '../raw-block-metadata';

describe('raw-block-metadata', () => {
  it('extracts hash, prevHash and size from the 80-byte header only', () => {
    const header = Buffer.alloc(80);
    header.writeInt32LE(1, 0);
    const prevHashLE = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    prevHashLE.copy(header, 4);
    const bytes = Buffer.concat([header, Buffer.from([1, 2, 3, 4])]);

    const metadata = extractRawBlockHeaderMetadata(bytes);

    expect(metadata.prevHash).toBe('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
    expect(metadata.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.size).toBe(84);
  });

  it('rejects data shorter than a block header', () => {
    expect(() => extractRawBlockHeaderMetadata(Buffer.alloc(79))).toThrow(/80-byte header/);
  });
});
