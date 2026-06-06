import { Buffer } from 'buffer';
import { asBufferView, copyBuffer, reverseHexBE } from '../buffer-view';

describe('buffer-view helpers', () => {
  it('asBufferView preserves Buffer identity', () => {
    const input = Buffer.from([1, 2, 3]);
    expect(asBufferView(input)).toBe(input);
  });

  it('asBufferView creates a zero-copy view over Uint8Array slices', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 8]);
    const slice = backing.subarray(1, 4);
    const view = asBufferView(slice);

    expect([...view]).toEqual([1, 2, 3]);
    backing[2] = 7;
    expect(view[1]).toBe(7);
  });

  it('copyBuffer creates an ownership snapshot', () => {
    const input = Buffer.from([1, 2, 3]);
    const copy = copyBuffer(input);

    expect(copy).not.toBe(input);
    input[0] = 9;
    expect([...copy]).toEqual([1, 2, 3]);
  });

  it('reverseHexBE renders reversed hex without mutating input', () => {
    const input = Buffer.from('00010203', 'hex');

    expect(reverseHexBE(input)).toBe('03020100');
    expect(input.toString('hex')).toBe('00010203');
  });
});
