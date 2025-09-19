import { hash as fastSha256 } from 'fast-sha256';
import { BitcoinMerkleVerifier as MV } from '../merkle-verifier';

function dsha(buf: Buffer): Buffer {
  const h1 = fastSha256(buf);
  const h2 = fastSha256(h1);
  return Buffer.from(h2);
}

function beToLe(hex: string) {
  return Buffer.from(hex.match(/../g)!.reverse().join(''), 'hex');
}

describe('BitcoinMerkleVerifier', () => {
  it('computeMerkleRoot returns leaf for single tx', () => {
    const tx = '11'.repeat(32);
    expect(MV.computeMerkleRoot([tx])).toBe(tx);
  });

  it('computeMerkleRoot handles odd leaves by duplicating last', () => {
    const a = '11'.repeat(32);
    const b = '22'.repeat(32);
    const c = '33'.repeat(32);
    const ab = dsha(Buffer.concat([beToLe(a), beToLe(b)]));
    const cc = dsha(Buffer.concat([beToLe(c), beToLe(c)]));
    const root = dsha(Buffer.concat([ab, cc])).reverse().toString('hex');
    expect(MV.computeMerkleRoot([a, b, c])).toBe(root);
  });

  it('verifyMerkleRoot true/false and empty case', () => {
    const a = 'aa'.repeat(32);
    const b = 'bb'.repeat(32);
    const root = MV.computeMerkleRoot([a, b]);
    expect(MV.verifyMerkleRoot([a, b], root)).toBe(true);
    expect(MV.verifyMerkleRoot([a, b], '00'.repeat(32))).toBe(false);
    expect(MV.verifyMerkleRoot([], '0'.repeat(64))).toBe(true);
  });

  it('computeWitnessMerkleRoot sets coinbase wtxid to zeros', () => {
    const w1 = '11'.repeat(32);
    const w2 = '22'.repeat(32);
    const computed = MV.computeWitnessMerkleRoot([w1, w2]);
    const expected = MV.computeMerkleRoot(['0'.repeat(64), w2]);
    expect(computed).toBe(expected);
  });

  it('verifyWitnessCommitment returns true on valid commitment', () => {
    const wtxids = ['77'.repeat(32), '88'.repeat(32), '99'.repeat(32)];
    const wrootBE = MV.computeWitnessMerkleRoot(wtxids);
    const wrootLE = beToLe(wrootBE);
    const reserved = Buffer.alloc(32, 0x00);
    const commit = dsha(Buffer.concat([wrootLE, reserved])).toString('hex');
    const coinbase = {
      vin: [{ txinwitness: ['aa', reserved.toString('hex')] }],
      vout: [{ scriptPubKey: { hex: `6a24aa21a9ed${commit}` } }],
    };
    const block = { tx: [coinbase, { wtxid: wtxids[1] }, { wtxid: wtxids[2] }] };
    expect(MV.verifyWitnessCommitment(block)).toBe(true);
  });

  it('verifyWitnessCommitment returns false on mismatch', () => {
    const coinbase = {
      vin: [{ txinwitness: ['00'.repeat(32)] }],
      vout: [{ scriptPubKey: { hex: `6a24aa21a9ed${'11'.repeat(32)}` } }],
    };
    const block = { tx: [coinbase, { wtxid: '22'.repeat(32) }] };
    expect(MV.verifyWitnessCommitment(block)).toBe(false);
  });

  it('verifyBlockMerkleRoot succeeds with tx strings only', () => {
    const a = 'aa'.repeat(32);
    const b = 'bb'.repeat(32);
    const root = MV.computeMerkleRoot([a, b]);
    const block = { merkleroot: root, tx: [a, b] };
    expect(MV.verifyBlockMerkleRoot(block)).toBe(true);
  });

  it('verifyGenesisMerkleRoot checks height=0 and one tx', () => {
    const only = 'aa'.repeat(32);
    const block = { height: 0, merkleroot: only, tx: [only] };
    expect(MV.verifyGenesisMerkleRoot(block)).toBe(true);
    const bad = { height: 0, merkleroot: only, tx: ['bb'.repeat(32), 'cc'.repeat(32)] };
    expect(MV.verifyGenesisMerkleRoot(bad)).toBe(false);
  });
});
