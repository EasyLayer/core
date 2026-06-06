import { hash as fastSha256 } from 'fast-sha256';
import { BitcoinMerkleVerifier as MV } from '../merkle-verifier';
import { setBitcoinNativeBindings } from '../../native';

function dsha(buf: Buffer): Buffer {
  const h1 = fastSha256(buf);
  const h2 = fastSha256(h1);
  return Buffer.from(h2);
}

function beToLe(hex: string) {
  return Buffer.from(hex.match(/../g)!.reverse().join(''), 'hex');
}

function computeMerkleRootNativeMock(txidsBE: string[]): string {
  if (!txidsBE || txidsBE.length === 0) throw new Error('Cannot compute Merkle root from empty transaction list');
  if (txidsBE.length === 1) return txidsBE[0]!.toLowerCase();

  let cur = txidsBE.map((txid) => beToLe(txid));
  while (cur.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i]!;
      const right = cur[i + 1] ?? left;
      next.push(dsha(Buffer.concat([left, right])));
    }
    cur = next;
  }
  return Buffer.from(cur[0]!).reverse().toString('hex').toLowerCase();
}

function verifyWitnessCommitmentNativeMock(block: any): boolean {
  try {
    if (!block?.tx?.length) return true;
    const coinbase = block.tx[0];
    const script = coinbase?.vout?.find((vout: any) => vout?.scriptPubKey?.hex?.startsWith('6a24aa21a9ed'))?.scriptPubKey
      ?.hex;
    if (!script) return true;

    const commitmentHex = script.slice(12, 12 + 64);
    const txs = block.tx ?? [];
    const wtxids: string[] = [];
    for (let i = 0; i < txs.length; i++) {
      if (i === 0) {
        wtxids.push('0'.repeat(64));
        continue;
      }
      const tx = txs[i];
      const value = typeof tx === 'string' ? tx : tx?.wtxid ?? tx?.hash ?? tx?.txid;
      if (typeof value !== 'string' || value.length !== 64) return false;
      wtxids.push(value.toLowerCase());
    }
    if (!wtxids.length) return true;

    const witnessRootBE = computeMerkleRootNativeMock(wtxids);
    const witnessRootLE = beToLe(witnessRootBE);
    const witness = coinbase?.vin?.[0]?.txinwitness ?? [];
    const reservedHex = [...witness].reverse().find((item) => typeof item === 'string' && item.length === 64);
    const reserved = Buffer.from(reservedHex ?? '00'.repeat(32), 'hex');
    const commit = dsha(Buffer.concat([witnessRootLE, reserved])).toString('hex');
    return commit.toLowerCase() === commitmentHex.toLowerCase();
  } catch {
    return false;
  }
}

function registerNativeMerkleMock(): void {
  setBitcoinNativeBindings({
    NativeMerkleVerifier: {
      bitcoinComputeMerkleRoot: computeMerkleRootNativeMock,
      bitcoinVerifyMerkleRoot: (txidsBE: string[], expectedRootBE: string) => {
        if (!expectedRootBE) return false;
        if (!txidsBE || txidsBE.length === 0) return expectedRootBE === '0'.repeat(64);
        return computeMerkleRootNativeMock(txidsBE) === expectedRootBE.toLowerCase();
      },
      bitcoinVerifyWitnessCommitment: verifyWitnessCommitmentNativeMock,
    },
  });
}

describe('BitcoinMerkleVerifier', () => {
  beforeEach(() => {
    registerNativeMerkleMock();
  });

  afterEach(() => {
    setBitcoinNativeBindings(undefined);
  });

  it('requires native verifier instead of falling back to JS', () => {
    setBitcoinNativeBindings(undefined);

    expect(() => MV.computeMerkleRoot(['11'.repeat(32)])).toThrow(/NativeMerkleVerifier requires the Bitcoin Rust native addon/);
  });

  it('does not silently fall back to JS when native verifier throws', () => {
    setBitcoinNativeBindings({
      NativeMerkleVerifier: {
        bitcoinComputeMerkleRoot: () => {
          throw new Error('native compute failed');
        },
        bitcoinVerifyMerkleRoot: () => true,
        bitcoinVerifyWitnessCommitment: () => true,
      },
    });

    expect(() => MV.computeMerkleRoot(['11'.repeat(32)])).toThrow(
      /NativeMerkleVerifier\.bitcoinComputeMerkleRoot failed: native compute failed/
    );
  });

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
