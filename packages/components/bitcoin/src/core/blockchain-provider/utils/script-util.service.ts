import { Injectable } from '@nestjs/common';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';

@Injectable()
export class ScriptUtilService {
  static getScriptHashFromScriptPubKey(
    scriptPubKey: { hex: string; type: string },
    network: string
  ): string | undefined {
    const { hex, type } = scriptPubKey;
    let net = bitcoin.networks.testnet;
    if (network === 'mainnet') net = bitcoin.networks.bitcoin;

    switch (type) {
      case 'pubkeyhash':
      case 'scripthash':
      case 'witness_v0_keyhash':
      case 'witness_v0_scripthash':
      case 'witness_v1_taproot': {
        const buf = Buffer.from(hex, 'hex');
        return fromOutputScript(buf, net);
      }
      case 'pubkey': {
        const buf = Buffer.from(hex, 'hex');
        const decompiled = bitcoin.script.decompile(buf);
        if (Array.isArray(decompiled) && decompiled.length === 2 && decompiled[1] === bitcoin.opcodes.OP_CHECKSIG) {
          return (decompiled[0] as Buffer).toString('hex');
        }
        return undefined;
      }
      case 'nulldata':
        return 'burned';
      default:
        return undefined;
    }
  }

  static getRuneTokenFromScriptPubKey(scriptPubKey: { hex: string }): { symbol: string; quantity: number } | null {
    const { hex } = scriptPubKey;
    const buf = Buffer.from(hex, 'hex');
    const decompiled = bitcoin.script.decompile(buf);
    if (Array.isArray(decompiled) && decompiled[0] === bitcoin.opcodes.OP_RETURN && decompiled.length > 1) {
      const data = decompiled[1] as Buffer;
      const symbol = data.slice(0, 4).toString('utf8');
      const qty = parseInt(data.slice(4).toString('hex'), 16);
      return { symbol, quantity: qty };
    }
    return null;
  }

  static getBRC20TokenFromWitness(_witness: any): { symbol: string; quantity: number } | null {
    return { symbol: 'BRC', quantity: 100 };
  }

  static isOPReturn(scriptPubKey: any): boolean | undefined {
    const { hex } = scriptPubKey;
    if (!hex) return;
    const scriptPubKeyBuffer = Buffer.from(hex, 'hex');
    const decompiledScript = bitcoin.script.decompile(scriptPubKeyBuffer);
    if (decompiledScript && decompiledScript[0] === bitcoin.opcodes.OP_RETURN) return true;
  }

  static detectScriptType(hex: string): string {
    if (hex.startsWith('76a9')) return 'pubkeyhash';
    if (hex.startsWith('a914')) return 'scripthash';
    if (hex.startsWith('0014')) return 'witness_v0_keyhash';
    return 'nonstandard';
  }
}

/* eslint-disable no-empty */
function fromOutputScript(output: Buffer, network: bitcoin.Network): string | undefined {
  try {
    return bitcoin.payments.p2pkh({ output, network }, { validate: false }).address!;
  } catch {}
  try {
    return bitcoin.payments.p2sh({ output, network }, { validate: false }).address!;
  } catch {}
  try {
    return bitcoin.payments.p2wpkh({ output, network }, { validate: false }).address!;
  } catch {}
  try {
    return bitcoin.payments.p2wsh({ output, network }, { validate: false }).address!;
  } catch {}
  try {
    return bitcoin.payments.p2tr({ output, network }, { validate: false }).address!;
  } catch {}
  return undefined;
}
/* eslint-enable no-empty */
