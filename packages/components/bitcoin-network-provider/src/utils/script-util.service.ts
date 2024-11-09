import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';

@Injectable()
export class ScriptUtilService {
  static getScriptHashFromScriptPubKey(scriptPubKey: any, networkName: string): string | null {
    const { hex, type } = scriptPubKey;

    let network: bitcoin.Network = bitcoin.networks.testnet;

    if (networkName === 'mainnet') {
      network = bitcoin.networks.bitcoin;
    }

    let scriptHash: string | null = null;

    switch (type) {
      // Types that require 'hex' to process
      // O(n), where n is the length of hex
      case 'pubkeyhash':
      case 'scripthash':
      case 'witness_v0_keyhash':
      case 'witness_v0_scripthash':
      case 'witness_v1_taproot':
        if (!hex) {
          // Missing 'hex'
          return null;
        }
        const scriptPubKeyBuffer = Buffer.from(hex, 'hex');
        scriptHash = bitcoin.address.fromOutputScript(scriptPubKeyBuffer, network);
        break;

      // O(n + m), where n is the hex length, m is the number of elements in the script.
      case 'pubkey':
        if (!hex) {
          // Missing 'hex'
          return null;
        }
        const scriptPubKeyBufferPubkey = Buffer.from(hex, 'hex');
        // Decompile script to get public key
        const decompiledScript = bitcoin.script.decompile(scriptPubKeyBufferPubkey);
        if (decompiledScript && decompiledScript.length === 2 && decompiledScript[1] === bitcoin.opcodes.OP_CHECKSIG) {
          // Extract public key as hex string
          scriptHash = (decompiledScript[0] as Buffer).toString('hex');
        }
        break;

      case 'nulldata':
        // 'nulldata' type represents burned outputs
        scriptHash = 'burned';
        break;

      // Types that do not require 'hex' or are not handled
      case 'multisig':
      case 'witness_unknown':
      case 'nonstandard':
        // Not handled; return null
        break;

      default:
        break;
    }

    return scriptHash;
  }

  static getRuneTokenFromScriptPubKey(scriptPubKey: any): { symbol: string; quantity: number } | null {
    const { hex } = scriptPubKey;

    if (!hex) {
      throw new Error('Invalid scriptPubKey: missing hex');
    }

    const scriptPubKeyBuffer = Buffer.from(hex, 'hex');
    const decompiledScript = bitcoin.script.decompile(scriptPubKeyBuffer);

    if (decompiledScript && decompiledScript[0] === bitcoin.opcodes.OP_RETURN && decompiledScript.length > 1) {
      const dataBuffer = decompiledScript[1] as Buffer;
      const tokenSymbol = dataBuffer.slice(0, 4).toString('utf-8');
      const tokenQuantity = parseInt(dataBuffer.slice(4).toString('hex'), 16);

      return { symbol: tokenSymbol, quantity: tokenQuantity };
    } else {
      return null;
    }
  }

  static getBRC20TokenFromWitness(witness: any): { symbol: string; quantity: number } | null {
    // Placeholder logic for extracting BRC-20 tokens from witness data
    console.log(witness);
    return { symbol: 'BRC', quantity: 100 };
  }

  static isOPReturn(scriptPubKey: any): boolean | undefined {
    const { hex } = scriptPubKey;

    if (!hex) {
      // TODO: think about this
      return;
    }

    const scriptPubKeyBuffer = Buffer.from(hex, 'hex');
    const decompiledScript = bitcoin.script.decompile(scriptPubKeyBuffer);

    if (decompiledScript && decompiledScript[0] === bitcoin.opcodes.OP_RETURN) {
      return true;
    }
  }
}
