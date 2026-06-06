import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { asBufferView } from './buffer-view';

const SIGHASH_FLAGS: Record<number, string> = {
  0x01: '[ALL]',
  0x02: '[NONE]',
  0x03: '[SINGLE]',
  0x81: '[ALL|ANYONECANPAY]',
  0x82: '[NONE|ANYONECANPAY]',
  0x83: '[SINGLE|ANYONECANPAY]',
};

function isDirectPush(opcode: number, length: number): boolean {
  return opcode >= 0x01 && opcode <= 0x4b && opcode === length;
}

function witnessVersion(opcode: number): number | undefined {
  if (opcode === 0x00) return 0;
  if (opcode >= 0x51 && opcode <= 0x60) return opcode - 0x50;
  return undefined;
}

function isDerSignatureWithSighash(bytes: Buffer): boolean {
  return bytes.length >= 9 && bytes[0] === 0x30 && SIGHASH_FLAGS[bytes[bytes.length - 1]!] !== undefined;
}

function formatPushDataLikeBitcoinCore(bytes: Buffer): string {
  if (isDerSignatureWithSighash(bytes)) {
    const sighash = bytes[bytes.length - 1]!;
    return `${bytes.subarray(0, bytes.length - 1).toString('hex')}${SIGHASH_FLAGS[sighash]}`;
  }
  return bytes.toString('hex');
}

/**
 * Format scriptPubKey ASM for Bitcoin Core getblock(..., 2) compatibility.
 * In particular, native witness programs are rendered as `0 <program>` /
 * `1 <program>` rather than bitcoinjs-lib's `OP_0 <program>` / `OP_1 <program>`.
 */
export function formatScriptPubKeyAsmLikeBitcoinCore(script: Buffer): string {
  try {
    if (script.length >= 4) {
      const version = witnessVersion(script[0]!);
      const pushLen = script[1]!;
      if (version !== undefined && isDirectPush(pushLen, script.length - 2)) {
        const program = script.subarray(2);
        if (program.length >= 2 && program.length <= 40) {
          // Bitcoin Core currently renders the ephemeral anchor output 51024e73 as `1 29518`.
          if (
            script.length === 4 &&
            script[0] === 0x51 &&
            script[1] === 0x02 &&
            script[2] === 0x4e &&
            script[3] === 0x73
          ) {
            return '1 29518';
          }
          return `${version} ${program.toString('hex')}`;
        }
      }
    }

    return bitcoin.script.toASM(script);
  } catch {
    return '';
  }
}

/**
 * Format scriptSig ASM for Bitcoin Core getblock(..., 2) compatibility.
 * DER signatures are displayed with symbolic sighash suffixes, e.g. `[ALL]`.
 */
export function formatScriptSigAsmLikeBitcoinCore(script: Buffer): string {
  try {
    const chunks = bitcoin.script.decompile(script);
    if (!chunks) return bitcoin.script.toASM(script);

    return chunks
      .map((chunk) => {
        if (typeof chunk === 'number') return bitcoin.script.toASM(Buffer.from([chunk]));
        return formatPushDataLikeBitcoinCore(asBufferView(chunk));
      })
      .join(' ');
  } catch {
    try {
      return bitcoin.script.toASM(script);
    } catch {
      return '';
    }
  }
}

export function detectBitcoinCoreScriptType(scriptHex: string): string | undefined {
  if (scriptHex.toLowerCase() === '51024e73') return 'anchor';
  return undefined;
}
