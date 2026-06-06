import { Buffer } from 'buffer';
import {
  detectBitcoinCoreScriptType,
  formatScriptPubKeyAsmLikeBitcoinCore,
  formatScriptSigAsmLikeBitcoinCore,
} from '../bitcoin-core-asm-formatter';

describe('bitcoin-core-asm-formatter', () => {
  it('formats witness programs using Bitcoin Core numeric witness versions', () => {
    expect(formatScriptPubKeyAsmLikeBitcoinCore(Buffer.from('0014e8c9190000000000000000000000000000000000', 'hex'))).toBe(
      '0 e8c9190000000000000000000000000000000000'
    );

    expect(
      formatScriptPubKeyAsmLikeBitcoinCore(
        Buffer.from('512002911b0000000000000000000000000000000000000000000000000000000000', 'hex')
      )
    ).toBe('1 02911b0000000000000000000000000000000000000000000000000000000000');
  });

  it('formats the ephemeral anchor output like Bitcoin Core', () => {
    expect(formatScriptPubKeyAsmLikeBitcoinCore(Buffer.from('51024e73', 'hex'))).toBe('1 29518');
    expect(detectBitcoinCoreScriptType('51024e73')).toBe('anchor');
  });

  it('formats DER scriptSig sighash suffixes symbolically', () => {
    const derWithAll = Buffer.from('47304402200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2002202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f4001', 'hex');
    const pubkey = Buffer.from('2102820000000000000000000000000000000000000000000000000000000000000000', 'hex');
    const script = Buffer.concat([derWithAll, pubkey]);

    expect(formatScriptSigAsmLikeBitcoinCore(script)).toContain('[ALL]');
    expect(formatScriptSigAsmLikeBitcoinCore(script)).not.toContain('4001');
  });
});
