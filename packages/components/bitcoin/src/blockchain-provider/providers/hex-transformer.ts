// ============================================================
//  HexTransformer
//  ------------------------------------------------------------
//  - Parses block/tx hex using bitcoinjs-lib.
//  - Converts header hashes to BE for RPC-style fields:
//      * hash          -> BE (bitcoinjs getId() already BE)
//      * merkleroot    -> convert LE Buffer -> BE hex
//      * prevHash      -> convert LE Buffer -> BE hex
//  - Produces Universal* structures. Sizes via BlockSizeCalculator.
//  - Computes wtxid in BE when SegWit is present.
//  - Works across BTC/BCH/LTC/DOGE; SegWit fields only if networkConfig.hasSegWit.
// ============================================================

import { Buffer } from 'node:buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { BlockSizeCalculator } from '../utils';
import type { UniversalBlock, UniversalTransaction, UniversalVin, UniversalVout, NetworkConfig } from '../transports';

function bufToHexBE(buf?: Buffer): string | undefined {
  if (!buf) return undefined;
  // Header stores merkleRoot/prevHash in LE; flip for BE display.
  return Buffer.from(buf).reverse().toString('hex');
}

export class HexTransformer {
  /**
   * Overload: parse block hex with known height
   */
  static parseBlockHex(hex: string, height: number, networkConfig: NetworkConfig): UniversalBlock;

  /**
   * Overload: parse block hex without height
   */
  static parseBlockHex(
    hex: string,
    networkConfig: NetworkConfig
  ): Omit<UniversalBlock, 'height'> & { height?: undefined };

  static parseBlockHex(
    hex: string,
    arg2: number | NetworkConfig,
    arg3?: NetworkConfig
  ): UniversalBlock | (Omit<UniversalBlock, 'height'> & { height?: undefined }) {
    if (!hex) throw new Error('Block hex is required');

    const networkConfig = typeof arg2 === 'number' ? (arg3 as NetworkConfig) : (arg2 as NetworkConfig);
    const height = typeof arg2 === 'number' ? arg2 : undefined;

    const buffer = Buffer.from(hex, 'hex');
    const btcBlock = bitcoin.Block.fromBuffer(buffer);

    // bitcoinjs:
    // - getId(): BE hex (ready for RPC display)
    // - merkleRoot/prevHash: Buffers in LE; must reverse to BE for RPC fields
    const hash = btcBlock.getId(); // BE
    const time = btcBlock.timestamp;

    // Parse txs
    const rawTxs = btcBlock.transactions ?? [];
    const transactions: UniversalTransaction[] = rawTxs.map((tx) =>
      this.parseTransactionFromBitcoinJS(tx, hash, time, networkConfig)
    );

    // Accurate sizes
    const sizeMetrics = BlockSizeCalculator.calculateSizeFromHex(hex, networkConfig);
    if (!BlockSizeCalculator.validateSizes(sizeMetrics)) {
      throw new Error(`Block size calculation validation failed for block: ${hash}`);
    }

    const base = {
      hash, // BE hex
      strippedsize: sizeMetrics.strippedSize,
      size: sizeMetrics.size,
      weight: sizeMetrics.weight,
      vsize: sizeMetrics.vsize,
      version: btcBlock.version,
      versionHex: '0x' + btcBlock.version.toString(16).padStart(8, '0'),

      // IMPORTANT: LE -> BE for RPC
      merkleroot: bufToHexBE(btcBlock.merkleRoot) ?? '',

      time,
      mediantime: time, // if you don't track MTP, keep equal to time
      nonce: btcBlock.nonce,
      bits: '0x' + btcBlock.bits.toString(16).padStart(8, '0'),
      difficulty: this.calculateDifficulty(btcBlock.bits),

      chainwork: '', // not derivable here
      previousblockhash: bufToHexBE(btcBlock.prevHash),
      nextblockhash: undefined,

      tx: transactions,
      nTx: transactions.length,
    };

    return height !== undefined
      ? ({ height, ...base } as UniversalBlock)
      : (base as Omit<UniversalBlock, 'height'> & { height?: undefined });
  }

  /**
   * Parse raw transaction hex into UniversalTransaction
   */
  static parseTransactionHex(
    hex: string,
    networkConfig: NetworkConfig,
    blockhash?: string,
    time?: number,
    blocktime?: number
  ): UniversalTransaction {
    if (!hex) throw new Error('Transaction hex is required');

    const buffer = Buffer.from(hex, 'hex');
    const tx = bitcoin.Transaction.fromBuffer(buffer);

    const sizeMetrics = BlockSizeCalculator.calculateTransactionSizeFromHex(hex, networkConfig);
    if (!BlockSizeCalculator.validateSizes(sizeMetrics)) {
      throw new Error(`Transaction size calculation validation failed for tx: ${tx.getId()}`);
    }

    return this.parseTransactionFromBitcoinJS(
      tx,
      blockhash,
      time ?? blocktime,
      networkConfig,
      time,
      blocktime,
      sizeMetrics
    );
  }

  /**
   * Parse bitcoin.Transaction into UniversalTransaction (with optional pre-computed sizes).
   */
  private static parseTransactionFromBitcoinJS(
    tx: bitcoin.Transaction,
    blockhash?: string,
    time?: number,
    networkConfig?: NetworkConfig,
    txTime?: number,
    blocktime?: number,
    preCalculatedSizes?: { size: number; strippedSize: number; vsize: number; weight: number; witnessSize?: number }
  ): UniversalTransaction {
    const vin = tx.ins.map((input, i) => this.parseVin(input, i, networkConfig));
    const vout = tx.outs.map((output, i) => this.parseVout(output, i));

    let size: number;
    let strippedSize: number;
    let weight: number;
    let vsize: number;

    if (preCalculatedSizes) {
      ({ size, strippedSize, weight, vsize } = preCalculatedSizes);
    } else {
      const m = BlockSizeCalculator.calculateTransactionSizeFromBitcoinJS(tx, networkConfig);
      ({ size, strippedSize, weight, vsize } = m);
    }

    // bitcoinjs:
    // - getId(): BE txid (for display/RPC)
    // - getHash(false): Buffer in LE; reverse to BE for wtxid string
    const result: UniversalTransaction = {
      txid: tx.getId(), // BE
      hash: tx.getId(), // keep for compatibility
      version: tx.version,
      size,
      vsize,
      weight,
      locktime: tx.locktime,
      vin,
      vout,
      blockhash,
      time: txTime ?? time,
      blocktime: blocktime ?? time,
    };

    if (networkConfig?.hasSegWit && tx.hasWitnesses()) {
      const wtxidBE = Buffer.from(tx.getHash(true)).reverse().toString('hex'); // true = include witness
      result.wtxid = wtxidBE;
    }

    return result;
  }

  private static parseVin(
    input: bitcoin.Transaction['ins'][0],
    index: number,
    networkConfig?: NetworkConfig
  ): UniversalVin {
    // Coinbase: prev hash = 32x00, index = 0xffffffff
    const isCoinbase = input.hash.every((b) => b === 0) && input.index === 0xffffffff;
    if (isCoinbase) {
      return { coinbase: input.script.toString('hex'), sequence: input.sequence };
    }

    const vin: UniversalVin = {
      // Previous-outpoint txid is serialized LE in the tx; convert to BE for display.
      txid: bufToHexBE(input.hash)!,
      vout: input.index,
      scriptSig: { asm: this.safeToASM(input.script), hex: input.script.toString('hex') },
      sequence: input.sequence,
    };

    if (networkConfig?.hasSegWit && input.witness?.length) {
      vin.txinwitness = input.witness.map((w) => w.toString('hex'));
    }

    return vin;
  }

  private static parseVout(output: bitcoin.Transaction['outs'][0], index: number): UniversalVout {
    const scriptHex = output.script.toString('hex');
    return {
      value: output.value / 1e8,
      n: index,
      scriptPubKey: {
        asm: this.safeToASM(output.script),
        hex: scriptHex,
        type: this.detectScriptType(scriptHex),
        addresses: undefined, // address derivation is network-specific; omitted here
      },
    };
  }

  private static detectScriptType(scriptHex: string): string {
    const script = Buffer.from(scriptHex, 'hex');
    try {
      if (
        script.length === 25 &&
        script[0] === 0x76 && // OP_DUP
        script[1] === 0xa9 && // OP_HASH160
        script[2] === 0x14 && // push 20
        script[23] === 0x88 && // OP_EQUALVERIFY
        script[24] === 0xac // OP_CHECKSIG
      )
        return 'pubkeyhash';
      if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return 'scripthash';
      if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 'witness_v0_keyhash';
      if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return 'witness_v0_scripthash';
      if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 'witness_v1_taproot';
      if ((script.length === 35 || script.length === 67) && script[script.length - 1] === 0xac) return 'pubkey';
      if (script[0] === 0x6a) return 'nulldata';
      if (script[script.length - 1] === 0xae) return 'multisig';
      return 'nonstandard';
    } catch {
      return 'unknown';
    }
  }

  private static calculateDifficulty(bits: number): string {
    try {
      const target = this.bitsToTarget(bits);
      const max = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
      if (target === BigInt(0)) return '0';
      return (max / target).toString();
    } catch {
      return '0';
    }
  }

  private static bitsToTarget(bits: number): bigint {
    const exp = bits >>> 24;
    const mant = bits & 0xffffff;
    return exp <= 3 ? BigInt(mant) >> BigInt(8 * (3 - exp)) : BigInt(mant) << BigInt(8 * (exp - 3));
  }

  private static safeToASM(script: Buffer): string {
    try {
      return bitcoin.script.toASM(script);
    } catch {
      return '';
    }
  }
}
