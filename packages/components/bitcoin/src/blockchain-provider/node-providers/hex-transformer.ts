import { Buffer } from 'node:buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { BlockSizeCalculator } from '../utils';
import type { UniversalBlock, UniversalTransaction, UniversalVin, UniversalVout, NetworkConfig } from './interfaces';

/**
 * Utility class for transforming hex data to Universal Bitcoin objects
 * Uses BlockSizeCalculator for accurate size metrics
 * Returns Universal objects without height when height is unknown
 */
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
    if (!hex) {
      throw new Error('Block hex is required');
    }

    const networkConfig = typeof arg2 === 'number' ? arg3! : (arg2 as NetworkConfig);
    const height = typeof arg2 === 'number' ? arg2 : undefined;

    const buffer = Buffer.from(hex, 'hex');
    const btcBlock = bitcoin.Block.fromBuffer(buffer);
    const hash = btcBlock.getId();
    const time = btcBlock.timestamp;

    // Parse transactions list
    const txs = btcBlock.transactions ?? [];
    const transactions: UniversalTransaction[] = txs.map((tx) =>
      this.parseTransactionFromBitcoinJS(tx, hash, time, networkConfig)
    );

    // Use BlockSizeCalculator for accurate size metrics
    const sizeMetrics = BlockSizeCalculator.calculateSizeFromHex(hex, networkConfig);

    // Validate calculated sizes
    if (!BlockSizeCalculator.validateSizes(sizeMetrics)) {
      throw new Error(`Block size calculation validation failed for block: ${hash}`);
    }

    // Build base block object
    const base = {
      hash,
      strippedsize: sizeMetrics.strippedSize,
      size: sizeMetrics.size,
      weight: sizeMetrics.weight,
      vsize: sizeMetrics.vsize,
      version: btcBlock.version,
      versionHex: '0x' + btcBlock.version.toString(16).padStart(8, '0'),
      merkleroot: btcBlock.merkleRoot?.toString('hex') ?? '',
      time,
      mediantime: time,
      nonce: btcBlock.nonce,
      bits: '0x' + btcBlock.bits.toString(16).padStart(8, '0'),
      difficulty: this.calculateDifficulty(btcBlock.bits),
      chainwork: '',
      previousblockhash: this.bufferToHex(btcBlock.prevHash),
      nextblockhash: undefined,
      tx: transactions,
      nTx: transactions.length,
    };

    if (height !== undefined) {
      return { height, ...base };
    } else {
      return base as Omit<UniversalBlock, 'height'> & { height?: undefined };
    }
  }

  /**
   * Parse raw transaction hex into Universal Transaction object
   * Uses BlockSizeCalculator for accurate size metrics
   */
  static parseTransactionHex(
    hex: string,
    networkConfig: NetworkConfig,
    blockhash?: string,
    time?: number,
    blocktime?: number
  ): UniversalTransaction {
    if (!hex) {
      throw new Error('Transaction hex is required');
    }

    const buffer = Buffer.from(hex, 'hex');
    const tx = bitcoin.Transaction.fromBuffer(buffer);

    // Calculate accurate transaction sizes using BlockSizeCalculator
    const sizeMetrics = BlockSizeCalculator.calculateTransactionSizeFromHex(hex, networkConfig);

    // Validate calculated sizes
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
   * Parse bitcoin.Transaction into UniversalTransaction
   * Enhanced with optional pre-calculated size metrics
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

    // Use pre-calculated sizes if available, otherwise calculate from transaction
    let size: number;
    let strippedSize: number;
    let weight: number;
    let vsize: number;

    if (preCalculatedSizes) {
      size = preCalculatedSizes.size;
      strippedSize = preCalculatedSizes.strippedSize;
      weight = preCalculatedSizes.weight;
      vsize = preCalculatedSizes.vsize;
    } else {
      // Calculate sizes using BlockSizeCalculator
      const sizeMetrics = BlockSizeCalculator.calculateTransactionSizeFromBitcoinJS(tx, networkConfig);
      size = sizeMetrics.size;
      strippedSize = sizeMetrics.strippedSize;
      weight = sizeMetrics.weight;
      vsize = sizeMetrics.vsize;
    }

    const result: UniversalTransaction = {
      txid: tx.getId(),
      hash: tx.getId(),
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

    // Add SegWit fields if supported
    if (networkConfig?.hasSegWit && tx.hasWitnesses()) {
      result.wtxid = tx.getHash(false).toString('hex');
    }

    return result;
  }

  private static parseVin(
    input: bitcoin.Transaction['ins'][0],
    index: number,
    networkConfig?: NetworkConfig
  ): UniversalVin {
    const isCoinbase = input.hash.every((b) => b === 0) && input.index === 0xffffffff;
    if (isCoinbase) {
      return { coinbase: input.script.toString('hex'), sequence: input.sequence };
    }

    const vin: UniversalVin = {
      txid: this.bufferToHex(input.hash),
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
        addresses: undefined,
      },
    };
  }

  private static calculateStrippedTxSize(tx: bitcoin.Transaction): number {
    let s = 4;
    s += this.getVarintSize(tx.ins.length);
    for (const inp of tx.ins) {
      s += 32 + 4 + this.getVarintSize(inp.script.length) + inp.script.length + 4;
    }
    s += this.getVarintSize(tx.outs.length);
    for (const out of tx.outs) {
      s += 8 + this.getVarintSize(out.script.length) + out.script.length;
    }
    s += 4;
    return s;
  }

  private static detectScriptType(scriptHex: string): string {
    const script = Buffer.from(scriptHex, 'hex');
    try {
      if (
        script.length === 25 &&
        script[0] === 0x76 &&
        script[1] === 0xa9 &&
        script[2] === 0x14 &&
        script[23] === 0x88 &&
        script[24] === 0xac
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

  private static bufferToHex(buf?: Buffer): string | undefined {
    if (!buf) return undefined;
    return Buffer.from(buf).reverse().toString('hex');
  }

  private static getVarintSize(i: number): number {
    if (i < 0xfd) return 1;
    if (i <= 0xffff) return 3;
    if (i <= 0xffffffff) return 5;
    return 9;
  }
}
