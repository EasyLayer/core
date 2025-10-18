import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type {
  UniversalBlock,
  UniversalBlockStats,
  UniversalMempoolInfo,
  UniversalMempoolTxMetadata,
  UniversalTransaction,
  UniversalVin,
  UniversalVout,
} from './interfaces';
import type { NetworkConfig } from '../transports';
import { BlockSizeCalculator } from '../utils';

/**
 * UniversalTransformer
 *
 * Single source of truth for:
 * 1) Parsing blocks/transactions from BYTES (preferred) using bitcoinjs-lib → Universal*.
 * 2) Normalizing RPC "verbose" JSON objects → Universal* (no defaults, no fabrication).
 * 3) Unit conversions (coin → smallest units; coin/kvB → smallest-unit per vB), network-aware.
 *
 * Design goals:
 * - No duplication across providers: both NetworkProvider and MempoolProvider call into here.
 * - Preserve order in providers; transformer is stateless and deterministic.
 * - Never fabricate required fields; leave missing as undefined, let domain normalizers enforce.
 *
 * Complexity:
 * - Parsing from bytes: O(#tx + sum(io counts)), memory proportional to decoded structure.
 * - Normalization from RPC: O(1) per object.
 */

function bufToHexBE(buf?: Buffer): string | undefined {
  if (!buf) return undefined;
  return Buffer.from(buf).reverse().toString('hex');
}

/** Zero-copy Buffer view from Uint8Array. */
function bufferFromU8(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

/** Numeric helper (finite -> number, else undefined). */
function nnum(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/** coin -> smallest units (e.g., BTC → sats) using network decimals. */
function unitFactor(decimals: number) {
  return Math.pow(10, Math.max(0, decimals | 0));
}
function toSmallestUnits(valueInCoin: any, factor: number): number | undefined {
  const n = Number(valueInCoin);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * factor);
}
/** coin/kvB -> smallest-unit per vB. */
function toSmallestPerVb_FromPerKvB(valueInCoinPerKvB: any, factor: number): number | undefined {
  const n = Number(valueInCoinPerKvB);
  if (!Number.isFinite(n)) return undefined;
  return Math.round((n * factor) / 1000);
}
/** coin/kB -> smallest-unit per vB. */
function toSmallestPerVb_FromPerKB(valueInCoinPerKB: any, factor: number): number | undefined {
  const n = Number(valueInCoinPerKB);
  if (!Number.isFinite(n)) return undefined;
  return Math.round((n * factor) / 1000);
}

export class UniversalTransformer {
  // =======================
  // BYTES PARSERS (preferred)
  // =======================

  /** Parse block bytes with known height. */
  static parseBlockBytes(u8: Uint8Array, height: number, net: NetworkConfig): UniversalBlock;
  /** Parse block bytes without height. */
  static parseBlockBytes(u8: Uint8Array, net: NetworkConfig): Omit<UniversalBlock, 'height'> & { height?: undefined };
  static parseBlockBytes(
    u8: Uint8Array,
    arg2: number | NetworkConfig,
    arg3?: NetworkConfig
  ): UniversalBlock | (Omit<UniversalBlock, 'height'> & { height?: undefined }) {
    if (!u8 || u8.byteLength === 0) throw new Error('Block bytes are required');
    const net = (typeof arg2 === 'number' ? arg3 : arg2) as NetworkConfig;
    const height = typeof arg2 === 'number' ? arg2 : undefined;

    const buffer = bufferFromU8(u8);
    const btcBlock = bitcoin.Block.fromBuffer(buffer);

    return this.buildUniversalBlockFromBitcoinJS(btcBlock, buffer, net, height);
  }

  /** Parse transaction bytes. */
  static parseTxBytes(
    u8: Uint8Array,
    net: NetworkConfig,
    blockhash?: string,
    time?: number,
    blocktime?: number
  ): UniversalTransaction {
    if (!u8 || u8.byteLength === 0) throw new Error('Transaction bytes are required');
    const buffer = bufferFromU8(u8);
    const tx = bitcoin.Transaction.fromBuffer(buffer);

    const m = BlockSizeCalculator.calculateTransactionSizeFromBitcoinJS(tx, net);
    if (!BlockSizeCalculator.validateSizes(m)) {
      throw new Error(`Transaction size calculation validation failed for tx: ${tx.getId()}`);
    }
    return this.parseTransactionFromBitcoinJS(tx, blockhash, time ?? blocktime, net, time, blocktime, {
      size: m.size,
      strippedSize: m.strippedSize,
      vsize: m.vsize,
      weight: m.weight,
      witnessSize: m.witnessSize,
    });
  }

  // =======================
  // RPC NORMALIZERS
  // =======================

  /** Raw RPC "verbose" tx → UniversalTransaction (network-aware sizes, no fabrication). */
  static normalizeRpcTransaction(raw: any, net: NetworkConfig): UniversalTransaction {
    const hasSegWit = !!net.hasSegWit;

    const sizeNum = nnum(raw?.size);
    const weightNum = nnum(raw?.weight);
    const vsizeNum = nnum(raw?.vsize);

    // vsize: prefer RPC; else derive from weight
    const vsize = vsizeNum ?? (Number.isFinite(weightNum!) ? Math.ceil((weightNum as number) / 4) : undefined);

    // strippedsize: best effort:
    // - if both size and weight present, derive base size via witness accounting:
    //     weight = base*4 + witness
    //     size   = base + witness
    //     => base = (weight - size) / 3
    let strippedsize: number | undefined;
    if (Number.isFinite(sizeNum!) && Number.isFinite(weightNum!)) {
      const base = ((weightNum as number) - (sizeNum as number)) / 3;
      if (Number.isFinite(base) && base >= 0) strippedsize = Math.round(base);
    } else if (!hasSegWit) {
      // Non-SegWit chains: base == size; or derive from weight if only weight present.
      if (Number.isFinite(sizeNum!)) strippedsize = sizeNum as number;
      else if (Number.isFinite(weightNum!)) strippedsize = Math.floor((weightNum as number) / 4);
    }

    // witnessSize only for SegWit when size/base are valid
    const witnessSize =
      hasSegWit &&
      Number.isFinite(sizeNum!) &&
      Number.isFinite(strippedsize!) &&
      (sizeNum as number) >= (strippedsize as number)
        ? (sizeNum as number) - (strippedsize as number)
        : undefined;

    const out: UniversalTransaction = {
      txid: raw.txid,
      hash: raw.hash ?? raw.txid,
      version: raw.version,
      size: sizeNum,
      vsize,
      weight: weightNum,
      strippedsize,
      witnessSize,
      locktime: raw.locktime,
      vin: raw.vin,
      vout: raw.vout,
      time: raw.time,
      blockhash: raw.blockhash,
      blocktime: raw.blocktime,
      confirmations: raw.confirmations,
      fee: raw.fee,
      wtxid: raw.wtxid,
      depends: raw.depends,
      spentby: raw.spentby,
      bip125_replaceable: raw.bip125_replaceable,
    };
    return out;
  }

  /** Raw RPC "getblock" (verbosity 1|2) → UniversalBlock (tx may be strings or objects). */
  static normalizeRpcBlock(raw: any, net: NetworkConfig): UniversalBlock | null {
    if (!raw) return null;

    let tx: UniversalBlock['tx'] = undefined;
    if (Array.isArray(raw.tx)) {
      if (raw.tx.length > 0 && typeof raw.tx[0] === 'string') {
        tx = raw.tx as string[];
      } else {
        tx = (raw.tx as any[]).map((t) => this.normalizeRpcTransaction(t, net));
      }
    }

    const weightNum = nnum(raw.weight);
    const vsize = Number.isFinite(weightNum!) ? Math.ceil((weightNum as number) / 4) : raw.vsize;

    const out: UniversalBlock = {
      hash: raw.hash,
      height: raw.height,
      strippedsize: raw.strippedsize,
      size: raw.size,
      weight: raw.weight,
      vsize,
      version: raw.version,
      versionHex: raw.versionHex,
      merkleroot: raw.merkleroot,
      time: raw.time,
      nonce: raw.nonce,
      bits: raw.bits,
      difficulty: raw.difficulty,
      previousblockhash: raw.previousblockhash,
      tx,
      nTx: raw.nTx,
      fee: raw.fee,
      subsidy: raw.subsidy,
      miner: raw.miner,
      pool: raw.pool,
    };
    return out;
  }

  /** Raw RPC "getblockstats" → UniversalBlockStats. */
  static normalizeRpcBlockStats(raw: any): UniversalBlockStats | null {
    if (!raw) return null;
    return {
      blockhash: raw.blockhash,
      height: raw.height,
      total_size: raw.total_size,
      total_weight: raw.total_weight,
      total_fee: raw.total_fee,
      fee_rate_percentiles: raw.fee_rate_percentiles,
      subsidy: raw.subsidy,
      total_out: raw.total_out,
      utxo_increase: raw.utxo_increase,
      utxo_size_inc: raw.utxo_size_inc,
      ins: raw.ins,
      outs: raw.outs,
      txs: raw.txs,
      minfee: raw.minfee,
      maxfee: raw.maxfee,
      medianfee: raw.medianfee,
      avgfee: raw.avgfee,
      minfeerate: raw.minfeerate,
      maxfeerate: raw.maxfeerate,
      medianfeerate: raw.medianfeerate,
      avgfeerate: raw.avgfeerate,
      mintxsize: raw.mintxsize,
      maxtxsize: raw.maxtxsize,
      mediantxsize: raw.mediantxsize,
      avgtxsize: raw.avgtxsize,
      total_stripped_size: raw.total_stripped_size,
      witness_txs: raw.witness_txs,
      time: raw.time,
    };
  }

  /** Raw RPC "getmempoolinfo" → UniversalMempoolInfo (units converted). */
  static normalizeRpcMempoolInfo(raw: any, net: NetworkConfig): UniversalMempoolInfo {
    const factor = unitFactor(net.nativeCurrencyDecimals);
    return {
      loaded: !!raw?.loaded,
      size: nnum(raw?.size),
      bytes: nnum(raw?.bytes),
      usage: nnum(raw?.usage),
      total_fee: toSmallestUnits(raw?.total_fee, factor),
      maxmempool: nnum(raw?.maxmempool),
      mempoolminfee: toSmallestPerVb_FromPerKvB(raw?.mempoolminfee, factor),
      minrelaytxfee: toSmallestPerVb_FromPerKvB(raw?.minrelaytxfee, factor),
      unbroadcastcount: nnum(raw?.unbroadcastcount),
      incrementalrelayfee: toSmallestPerVb_FromPerKvB(raw?.incrementalrelayfee, factor),
      fullrbf: !!raw?.fullrbf,
    };
  }

  /** Raw RPC "getmempoolentry"/getrawmempool(true) entry → UniversalMempoolTxMetadata (units converted). */
  static normalizeRpcMempoolEntry(e: any, net: NetworkConfig, txidFromKey?: string): UniversalMempoolTxMetadata {
    const fees = e?.fees ?? {};
    const factor = unitFactor(net.nativeCurrencyDecimals);
    return {
      txid: txidFromKey ?? e?.txid ?? '',
      wtxid: e?.wtxid,
      vsize: nnum(e?.vsize),
      weight: nnum(e?.weight),
      fee: toSmallestUnits(fees.base, factor),
      modifiedfee: toSmallestUnits(fees.modified, factor),
      time: nnum(e?.time),
      height: nnum(e?.height),
      depends: Array.isArray(e?.depends) ? e.depends : undefined,
      spentby: Array.isArray(e?.spentby) ? e.spentby : undefined,
      descendantcount: nnum(e?.descendantcount),
      descendantsize: nnum(e?.descendantsize),
      descendantfees: toSmallestUnits(fees.descendant, factor),
      ancestorcount: nnum(e?.ancestorcount),
      ancestorsize: nnum(e?.ancestorsize),
      ancestorfees: toSmallestUnits(fees.ancestor, factor),
      fees: {
        base: toSmallestUnits(fees.base, factor),
        modified: toSmallestUnits(fees.modified, factor),
        ancestor: toSmallestUnits(fees.ancestor, factor),
        descendant: toSmallestUnits(fees.descendant, factor),
      },
      bip125_replaceable: !!(e?.['bip125-replaceable'] ?? e?.bip125_replaceable),
      unbroadcast: !!e?.unbroadcast,
    };
  }

  /** Raw RPC "estimatesmartfee" → { sat_per_vb?, blocks?, errors? }. */
  static normalizeRpcSmartFee(
    raw: any,
    net: NetworkConfig
  ): { sat_per_vb?: number; blocks?: number; errors?: string[] } {
    const factor = unitFactor(net.nativeCurrencyDecimals);
    return {
      sat_per_vb: toSmallestPerVb_FromPerKB(raw?.feerate, factor),
      blocks: raw?.blocks,
      errors: raw?.errors,
    };
  }

  // =======================
  // INTERNAL (bytes -> universal)
  // =======================

  private static buildUniversalBlockFromBitcoinJS(
    btcBlock: bitcoin.Block,
    buffer: Buffer,
    net: NetworkConfig,
    height?: number
  ): UniversalBlock | (Omit<UniversalBlock, 'height'> & { height?: undefined }) {
    const hash = btcBlock.getId();
    const time = btcBlock.timestamp;

    const rawTxs = btcBlock.transactions ?? [];
    const transactions: UniversalTransaction[] = rawTxs.map((tx) =>
      this.parseTransactionFromBitcoinJS(tx, hash, time, net)
    );

    const m = this.calculateBlockSizesFromBytes(btcBlock, buffer, net);
    if (!BlockSizeCalculator.validateSizes(m)) {
      throw new Error(`Block size calculation validation failed for block: ${hash}`);
    }

    const base = {
      hash,
      strippedsize: m.strippedSize,
      size: m.size,
      weight: m.weight,
      vsize: m.vsize,
      version: btcBlock.version,
      versionHex: '0x' + btcBlock.version.toString(16).padStart(8, '0'),
      merkleroot: bufToHexBE(btcBlock.merkleRoot) ?? '',
      time,
      mediantime: time, // no median time available from bitcoinjs
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

  private static calculateBlockSizesFromBytes(
    btcBlock: bitcoin.Block,
    buffer: Buffer,
    net: NetworkConfig
  ): { size: number; strippedSize: number; weight: number; vsize: number; witnessSize?: number } {
    const size = buffer.length;
    const txs = btcBlock.transactions || [];

    let strippedSize = 80; // header
    strippedSize += this.varintSize(txs.length);

    for (const tx of txs) strippedSize += this.strippedTxSize(tx as unknown as bitcoin.Transaction);

    let weight: number;
    let vsize: number;
    let witnessSize: number | undefined;

    if (net.hasSegWit) {
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

  private static parseTransactionFromBitcoinJS(
    tx: bitcoin.Transaction,
    blockhash?: string,
    time?: number,
    net?: NetworkConfig,
    txTime?: number,
    blocktime?: number,
    pre?: { size: number; strippedSize: number; vsize: number; weight: number; witnessSize?: number }
  ): UniversalTransaction {
    const vin = tx.ins.map((input, i) => this.parseVin(input, i, net));
    const vout = tx.outs.map((output, i) => this.parseVout(output, i));

    let size: number, strippedSize: number, weight: number, vsize: number;
    if (pre) ({ size, strippedSize, weight, vsize } = pre);
    else {
      const m = BlockSizeCalculator.calculateTransactionSizeFromBitcoinJS(tx, net!);
      ({ size, strippedSize, weight, vsize } = m);
    }

    const result: UniversalTransaction = {
      txid: tx.getId(),
      hash: tx.getId(),
      version: tx.version,
      size,
      vsize,
      weight,
      strippedsize: strippedSize,
      witnessSize: net?.hasSegWit ? size - strippedSize : undefined,
      locktime: tx.locktime,
      vin,
      vout,
      blockhash,
      time: txTime ?? time,
      blocktime: blocktime ?? time,
    };

    if (net?.hasSegWit && tx.hasWitnesses()) {
      const wtxidBE = Buffer.from(tx.getHash(true)).reverse().toString('hex');
      result.wtxid = wtxidBE;
    }

    return result;
  }

  private static parseVin(input: bitcoin.Transaction['ins'][0], _index: number, net?: NetworkConfig): UniversalVin {
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

    if (net?.hasSegWit && input.witness?.length) {
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

  private static varintSize(value: number): number {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

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

  private static safeToASM(script: Buffer): string {
    try {
      return bitcoin.script.toASM(script);
    } catch {
      return '';
    }
  }
}
