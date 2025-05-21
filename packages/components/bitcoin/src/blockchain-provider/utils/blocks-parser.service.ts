import { Buffer } from 'node:buffer';
import { Injectable } from '@nestjs/common';
import * as bitcoin from 'bitcoinjs-lib';
import { Block, Transaction, Vin, Vout } from '../components';
import { ScriptUtilService } from './script-util.service';

@Injectable()
export class BlockParserService {
  static safeToASM(script?: Buffer): string {
    if (!script || script.length === 0) return '';
    try {
      return bitcoin.script.toASM(script);
    } catch {
      return ''; // TODO: or log this script for diagnostics
    }
  }

  static parseVin(inp: bitcoin.Transaction['ins'][0], index: number): Vin {
    // coinbase-input is determined by zero prev-hash
    const isCoinbase = inp.hash.every((b) => b === 0);
    if (isCoinbase) {
      return {
        coinbase: inp.script?.toString('hex'),
        sequence: inp.sequence,
      };
    }
    return {
      txid: Buffer.from(inp.hash as any)
        .reverse()
        .toString('hex'),
      vout: inp.index,
      scriptSig: {
        asm: BlockParserService.safeToASM(inp.script),
        hex: inp.script!.toString('hex'),
      },
      sequence: inp.sequence,
    };
  }

  static parseVout(out: bitcoin.Transaction['outs'][0], index: number): Vout {
    const hex = out.script.toString('hex');
    const type = ScriptUtilService.detectScriptType(hex);
    // const address = ScriptUtilService.getScriptHashFromScriptPubKey(
    //   { hex, type },
    //   networkName
    // );
    return {
      value: out.value,
      n: index,
      scriptPubKey: {
        asm: BlockParserService.safeToASM(out.script),
        hex,
        type,
        // addresses: address ? [address] : [],
      },
    };
  }

  static parseTransaction(tx: bitcoin.Transaction, blockHash: string, time: number): Transaction {
    const vin: Vin[] = tx.ins.map((inp, i) => this.parseVin(inp, i));
    const vout: Vout[] = tx.outs.map((out, i) => this.parseVout(out, i));
    return {
      txid: tx.getId(),
      hash: tx.getId(),
      version: tx.version,
      size: tx.byteLength(),
      vsize: tx.virtualSize(),
      weight: tx.weight(),
      locktime: tx.locktime,
      vin,
      vout,
      hex: tx.toHex(),
      blockhash: blockHash,
      confirmations: 0,
      time,
      blocktime: time,
    };
  }

  static parseRawBlock(rawHex: string, height: number): Block {
    const buffer = Buffer.from(rawHex, 'hex');
    const btcBlock = bitcoin.Block.fromBuffer(buffer);

    const hash = btcBlock.getId();
    const time = btcBlock.timestamp;
    const tx: Transaction[] = (btcBlock.transactions ?? []).map((t) => this.parseTransaction(t, hash, time));

    // Converting little-endian buffers to the usual hex (big-endian)
    const previousblockhash = BlockParserService.toBigEndianHex(btcBlock.prevHash!);

    return {
      height,
      hash,
      confirmations: 0,
      strippedsize: buffer.length,
      size: buffer.length,
      weight: buffer.length * 4,
      version: btcBlock.version,
      versionHex: '0x' + btcBlock.version.toString(16),
      merkleroot: btcBlock.merkleRoot?.toString('hex') ?? '',
      time,
      mediantime: time,
      nonce: btcBlock.nonce,
      bits: '0x' + btcBlock.bits.toString(16),
      difficulty: '0',
      chainwork: '',
      previousblockhash,
      tx,
    };
  }

  // Converts a block buffer (LE) to a big-endian hex string
  private static toBigEndianHex(buffer: Buffer): string {
    return Buffer.from(buffer as any)
      .reverse()
      .toString('hex');
  }
}
