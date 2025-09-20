import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { BlockSizeCalculator } from '../utils';
import type { UniversalBlock, UniversalTransaction, UniversalVin, UniversalVout, NetworkConfig } from '../transports';

function bufToHexBE(buf?: Buffer): string | undefined {
  if (!buf) return undefined;
  return Buffer.from(buf).reverse().toString('hex');
}

/**
 * Safe Buffer view from Uint8Array without copying bytes.
 */
function bufferFromU8(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

// ============================================================
//  HexTransformer
//  ------------------------------------------------------------
//  - Parses block/tx from BYTES (preferred) or HEX using bitcoinjs-lib.
//  - Converts header hashes to BE for RPC-style fields:
//      * hash          -> BE (bitcoinjs getId() already BE)
//      * merkleroot    -> convert LE Buffer -> BE hex
//      * prevHash      -> convert LE Buffer -> BE hex
//  - Produces Universal* structures. Sizes are computed from BYTES
//    (no hex string allocations).
//  - Computes wtxid in BE when SegWit is present.
//  - Works across BTC/BCH/LTC/DOGE; SegWit fields only if networkConfig.hasSegWit.
// ============================================================

export class HexTransformer {
  // =======================
  // BYTES-BASED ENTRYPOINTS
  // =======================

  /**
   * Parse block bytes with known height (preferred path).
   */
  static parseBlockBytes(u8: Uint8Array, height: number, networkConfig: NetworkConfig): UniversalBlock;

  /**
   * Parse block bytes without height (preferred path).
   */
  static parseBlockBytes(
    u8: Uint8Array,
    networkConfig: NetworkConfig
  ): Omit<UniversalBlock, 'height'> & { height?: undefined };

  static parseBlockBytes(
    u8: Uint8Array,
    arg2: number | NetworkConfig,
    arg3?: NetworkConfig
  ): UniversalBlock | (Omit<UniversalBlock, 'height'> & { height?: undefined }) {
    if (!u8 || u8.byteLength === 0) throw new Error('Block bytes are required');

    const networkConfig = typeof arg2 === 'number' ? (arg3 as NetworkConfig) : (arg2 as NetworkConfig);
    const height = typeof arg2 === 'number' ? arg2 : undefined;

    const buffer = bufferFromU8(u8);
    const btcBlock = bitcoin.Block.fromBuffer(buffer);

    return this.buildUniversalBlockFromBitcoinJS(btcBlock, buffer, networkConfig, height);
  }

  /**
   * Parse transaction bytes (preferred path).
   */
  static parseTxBytes(
    u8: Uint8Array,
    networkConfig: NetworkConfig,
    blockhash?: string,
    time?: number,
    blocktime?: number
  ): UniversalTransaction {
    if (!u8 || u8.byteLength === 0) throw new Error('Transaction bytes are required');

    const buffer = bufferFromU8(u8);
    const tx = bitcoin.Transaction.fromBuffer(buffer);

    // Sizes from bitcoinjs Transaction (no hex conversions)
    const sizeMetrics = BlockSizeCalculator.calculateTransactionSizeFromBitcoinJS(tx, networkConfig);
    if (!BlockSizeCalculator.validateSizes(sizeMetrics)) {
      throw new Error(`Transaction size calculation validation failed for tx: ${tx.getId()}`);
    }

    return this.parseTransactionFromBitcoinJS(tx, blockhash, time ?? blocktime, networkConfig, time, blocktime, {
      size: sizeMetrics.size,
      strippedSize: sizeMetrics.strippedSize,
      vsize: sizeMetrics.vsize,
      weight: sizeMetrics.weight,
      witnessSize: sizeMetrics.witnessSize,
    });
  }

  // =======================
  // INTERNAL HELPERS
  // =======================

  /**
   * Build UniversalBlock from a bitcoinjs Block + raw bytes buffer.
   * Computes size/weight/vsize from bytes to avoid hex allocations.
   */
  private static buildUniversalBlockFromBitcoinJS(
    btcBlock: bitcoin.Block,
    buffer: Buffer,
    networkConfig: NetworkConfig,
    height?: number
  ): UniversalBlock | (Omit<UniversalBlock, 'height'> & { height?: undefined }) {
    const hash = btcBlock.getId();
    const time = btcBlock.timestamp;

    const rawTxs = btcBlock.transactions ?? [];
    const transactions: UniversalTransaction[] = rawTxs.map((tx) =>
      this.parseTransactionFromBitcoinJS(tx, hash, time, networkConfig)
    );

    // Compute sizes from bytes (mirrors logic in BlockSizeCalculator for blocks)
    const sizeMetrics = this.calculateBlockSizesFromBytes(btcBlock, buffer, networkConfig);
    if (!BlockSizeCalculator.validateSizes(sizeMetrics)) {
      throw new Error(`Block size calculation validation failed for block: ${hash}`);
    }

    const base = {
      hash,
      strippedsize: sizeMetrics.strippedSize,
      size: sizeMetrics.size,
      weight: sizeMetrics.weight,
      vsize: sizeMetrics.vsize,
      version: btcBlock.version,
      versionHex: '0x' + btcBlock.version.toString(16).padStart(8, '0'),
      merkleroot: bufToHexBE(btcBlock.merkleRoot) ?? '',
      time,
      mediantime: time, // no header median time in bitcoinjs, reuse timestamp
      nonce: btcBlock.nonce,
      bits: '0x' + btcBlock.bits.toString(16).padStart(8, '0'),
      difficulty: this.calculateDifficulty(btcBlock.bits),
      chainwork: '', // not derivable from a single block buffer
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
   * Compute stripped size / weight / vsize for a block from bytes.
   * This avoids any intermediate hex string allocations.
   */
  private static calculateBlockSizesFromBytes(
    btcBlock: bitcoin.Block,
    buffer: Buffer,
    networkConfig: NetworkConfig
  ): { size: number; strippedSize: number; weight: number; vsize: number; witnessSize?: number } {
    const size = buffer.length;
    const txs = btcBlock.transactions || [];

    // strippedSize = header(80) + varint(txCount) + sum(stripped(tx))
    let strippedSize = 80;
    strippedSize += this.varintSize(txs.length);

    for (const tx of txs) {
      strippedSize += this.strippedTxSize(tx as unknown as bitcoin.Transaction);
    }

    let weight: number;
    let vsize: number;
    let witnessSize: number | undefined;

    if (networkConfig.hasSegWit) {
      witnessSize = size > strippedSize ? size - strippedSize : undefined;
      weight = strippedSize * 4 + (witnessSize ?? 0);
      vsize = Math.ceil(weight / 4);
    } else {
      weight = strippedSize * 4;
      vsize = strippedSize;
      witnessSize = undefined;
    }

    return { size, strippedSize, weight, vsize, witnessSize };
  }

  /**
   * Stripped tx size from bitcoinjs Transaction shape (no witness data).
   */
  private static strippedTxSize(tx: bitcoin.Transaction): number {
    let size = 4; // version

    size += this.varintSize((tx as any).ins.length);
    for (const input of (tx as any).ins) {
      size += 32; // prevout hash
      size += 4; // prevout index
      size += this.varintSize(input.script.length);
      size += input.script.length;
      size += 4; // sequence
    }

    size += this.varintSize((tx as any).outs.length);
    for (const output of (tx as any).outs) {
      size += 8; // value
      size += this.varintSize(output.script.length);
      size += output.script.length;
    }

    size += 4; // locktime
    return size;
  }

  private static varintSize(value: number): number {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

  // =======================
  // COMMON TX/BLOCK PARSERS
  // =======================

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

    if (networkConfig?.hasSegWit && tx.hasWitnesses()) {
      const wtxidBE = Buffer.from(tx.getHash(true)).reverse().toString('hex');
      result.wtxid = wtxidBE;
    }

    return result;
  }

  private static parseVin(
    input: bitcoin.Transaction['ins'][0],
    _index: number,
    networkConfig?: NetworkConfig
  ): UniversalVin {
    const isCoinbase = input.hash.every((b) => b === 0) && input.index === 0xffffffff;
    if (isCoinbase) {
      return { coinbase: input.script.toString('hex'), sequence: input.sequence };
    }

    const vin: UniversalVin = {
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
        addresses: undefined,
      },
    };
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
}
