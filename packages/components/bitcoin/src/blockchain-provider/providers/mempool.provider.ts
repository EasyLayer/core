import type { UniversalMempoolTransaction, UniversalMempoolInfo, UniversalTransaction } from '../transports';
import { HexTransformer } from './hex-transformer';
import { BaseProvider } from './base.provider';

/**
 * Mempool Provider for mempool-specific operations
 *
 * Responsibilities:
 * - Mempool transaction retrieval and parsing
 * - Mempool information and statistics
 * - Raw mempool data access
 * - Fee estimation
 *
 * Currently works with RPC transport only (P2P support planned for future)
 * Supports Bitcoin-compatible chains (BTC, BCH, DOGE, LTC) via network config
 * Designed for multi-provider strategies (parallel, round-robin, fastest)
 */
export class MempoolProvider extends BaseProvider {
  /**
   * Get multiple transactions by txids as structured objects
   * Node calls: 1 (batch getrawtransaction for all txids)
   * Time complexity: O(k) where k = number of transactions
   *
   * @param txids Array of transaction IDs
   * @param verbosity Verbosity level for transaction data
   * @returns Array of transactions in same order as input, null for missing transactions
   */
  async getManyTransactionsByTxids(txids: string[], verbosity: number = 1): Promise<(UniversalTransaction | null)[]> {
    const requests = txids.map((txid) => ({
      method: 'getrawtransaction',
      params: [txid, verbosity],
    }));

    const results = await this.transport.batchCall(requests);

    return results.map((rawTx) => {
      if (rawTx === null) return null;
      return this.normalizeRawTransaction(rawTx);
    });
  }

  /**
   * Get multiple transactions by txids parsed from hex
   * Node calls: 1 (batch getrawtransaction with verbosity=0 for all txids)
   * Time complexity: O(k) where k = number of transactions
   *
   * @param txids Array of transaction IDs
   * @returns Array of transactions in same order as input, null for missing transactions
   */
  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    const hexRequests = txids.map((txid) => ({
      method: 'getrawtransaction',
      params: [txid, false], // false = hex format
    }));

    const hexResults = await this.transport.batchCall(hexRequests);

    return hexResults.map((hex) => {
      if (hex === null) return null;

      try {
        const parsedTx = HexTransformer.parseTransactionHex(hex, this.network);
        parsedTx.hex = hex;
        return parsedTx;
      } catch (error) {
        return null;
      }
    });
  }

  /**
   * Get mempool information
   * Node calls: 1 (getmempoolinfo)
   * Time complexity: O(1)
   * Memory usage: Minimal - just returns current mempool state
   *
   * @returns Normalized mempool information
   */
  async getMempoolInfo(): Promise<UniversalMempoolInfo> {
    const results = await this.transport.batchCall([{ method: 'getmempoolinfo', params: [] }]);
    const rawInfo = results[0];

    if (!rawInfo) {
      throw new Error('Failed to get mempool info');
    }

    return this.normalizeMempoolInfo(rawInfo);
  }

  /**
   * Get raw mempool data (transaction IDs or detailed entries)
   * Node calls: 1 (getrawmempool)
   * Time complexity: O(n) where n = number of transactions in mempool
   * Memory usage: Depends on mempool size and verbosity
   *
   * @param verbose If true, returns detailed transaction info; if false, returns array of txids
   * @returns Raw mempool data (format depends on verbose flag)
   */
  async getRawMempool(verbose: boolean = false): Promise<any> {
    const results = await this.transport.batchCall([{ method: 'getrawmempool', params: [verbose] }]);
    const rawResult = results[0];

    if (!verbose) {
      return rawResult; // string[] of transaction IDs
    }

    if (rawResult && typeof rawResult === 'object') {
      const normalizedMempool: { [txid: string]: UniversalMempoolTransaction } = {};

      for (const [txid, rawEntry] of Object.entries(rawResult)) {
        normalizedMempool[txid] = this.normalizeMempoolEntry(txid, rawEntry);
      }

      return normalizedMempool;
    }

    return rawResult;
  }

  /**
   * Get mempool entries for specific transactions
   * Node calls: 1 (batch getmempoolentry for all txids)
   * Time complexity: O(k) where k = number of txids requested
   *
   * @param txids Array of transaction IDs to get mempool entries for
   * @returns Array of mempool entries in same order as input, null for missing entries
   */
  async getMempoolEntries(txids: string[]): Promise<(UniversalMempoolTransaction | null)[]> {
    const requests = txids.map((txid) => ({ method: 'getmempoolentry', params: [txid] }));
    const results = await this.transport.batchCall(requests);

    return results.map((entry, index) => {
      if (entry === null) return null;
      return this.normalizeMempoolEntry(txids[index]!, entry);
    });
  }

  /**
   * Estimate smart fee for transaction confirmation
   * Node calls: 1 (estimatesmartfee)
   * Time complexity: O(1)
   *
   * @param confTarget Target number of confirmations
   * @param estimateMode Estimation mode ('CONSERVATIVE' or 'ECONOMICAL')
   * @returns Fee estimation data
   */
  async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    const results = await this.transport.batchCall([
      { method: 'estimatesmartfee', params: [confTarget, estimateMode] },
    ]);
    return results[0];
  }

  /**
   * Get current blockchain height
   * Node calls: 1 (getblockcount)
   * Time complexity: O(1)
   */
  async getBlockHeight(): Promise<number> {
    const results = await this.transport.batchCall([{ method: 'getblockcount', params: [] }]);
    return results[0];
  }

  // ===== NORMALIZATION METHODS =====

  /**
   * Convert coin amount to smallest unit (satoshis for Bitcoin)
   * Time complexity: O(1)
   */
  private coinToSmallestUnit(coinAmount: number): number {
    return Math.round(coinAmount * Math.pow(10, this.network.nativeCurrencyDecimals));
  }

  /**
   * Normalize raw mempool entry to UniversalMempoolTransaction format
   * Handles fee conversion from coin format to smallest unit
   *
   * @param txid Transaction ID
   * @param entry Raw mempool entry data
   * @returns Normalized mempool transaction
   */
  private normalizeMempoolEntry(txid: string, entry: any): UniversalMempoolTransaction {
    // Extract fee values (handle both old and new fee structure)
    const baseFee = entry.fees?.base ?? entry.fee;
    const modifiedFee = entry.fees?.modified ?? entry.modifiedfee;
    const ancestorFee = entry.fees?.ancestor ?? entry.ancestorfees;
    const descendantFee = entry.fees?.descendant ?? entry.descendantfees;

    // Validation
    if (baseFee === undefined || baseFee === null) {
      throw new Error(`Missing base fee for transaction ${txid}`);
    }

    if (!entry.vsize || entry.vsize <= 0) {
      throw new Error(`Invalid vsize for transaction ${txid}: ${entry.vsize}`);
    }

    // Convert to smallest unit if values are in coin format (< 1 indicates coin format)
    const baseFeeInSmallestUnit = baseFee < 1 ? this.coinToSmallestUnit(baseFee) : baseFee;
    const modifiedFeeInSmallestUnit =
      modifiedFee !== undefined && modifiedFee < 1 ? this.coinToSmallestUnit(modifiedFee) : modifiedFee;
    const ancestorFeeInSmallestUnit =
      ancestorFee !== undefined && ancestorFee < 1 ? this.coinToSmallestUnit(ancestorFee) : ancestorFee;
    const descendantFeeInSmallestUnit =
      descendantFee !== undefined && descendantFee < 1 ? this.coinToSmallestUnit(descendantFee) : descendantFee;

    return {
      txid,
      wtxid: entry.wtxid,
      size: entry.size,
      vsize: entry.vsize,
      weight: entry.weight,
      fee: baseFeeInSmallestUnit,
      modifiedfee: modifiedFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      time: entry.time ?? Math.floor(Date.now() / 1000),
      height: entry.height ?? -1,
      depends: entry.depends ?? [],
      descendantcount: entry.descendantcount ?? 0,
      descendantsize: entry.descendantsize ?? 0,
      descendantfees: descendantFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      ancestorcount: entry.ancestorcount ?? 0,
      ancestorsize: entry.ancestorsize ?? 0,
      ancestorfees: ancestorFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      fees: {
        base: baseFeeInSmallestUnit,
        modified: modifiedFeeInSmallestUnit ?? baseFeeInSmallestUnit,
        ancestor: ancestorFeeInSmallestUnit ?? baseFeeInSmallestUnit,
        descendant: descendantFeeInSmallestUnit ?? baseFeeInSmallestUnit,
      },
      bip125_replaceable: entry['bip125-replaceable'] ?? false,
      unbroadcast: entry.unbroadcast ?? false,
    };
  }

  /**
   * Normalize raw mempool info to UniversalMempoolInfo format
   * Handles fee rate conversion from BTC/kvB to sat/vB
   *
   * @param rawInfo Raw mempool info data
   * @returns Normalized mempool info
   */
  private normalizeMempoolInfo(rawInfo: any): UniversalMempoolInfo {
    // Validate required fields
    if (typeof rawInfo.size !== 'number') {
      throw new Error('Missing or invalid size in mempool info');
    }

    if (typeof rawInfo.bytes !== 'number') {
      throw new Error('Missing or invalid bytes in mempool info');
    }

    if (typeof rawInfo.maxmempool !== 'number') {
      throw new Error('Missing or invalid maxmempool in mempool info');
    }

    if (rawInfo.mempoolminfee === undefined || rawInfo.mempoolminfee === null) {
      throw new Error('Missing mempoolminfee in mempool info');
    }

    if (rawInfo.minrelaytxfee === undefined || rawInfo.minrelaytxfee === null) {
      throw new Error('Missing minrelaytxfee in mempool info');
    }

    // Convert BTC amounts to satoshis
    const totalFee =
      rawInfo.total_fee !== undefined && rawInfo.total_fee !== null ? this.coinToSmallestUnit(rawInfo.total_fee) : 0;

    // Convert fee rates from BTC/kvB to sat/vB
    const mempoolMinFee = Math.round((rawInfo.mempoolminfee * 100000000) / 1000);
    const minRelayTxFee = Math.round((rawInfo.minrelaytxfee * 100000000) / 1000);

    return {
      loaded: rawInfo.loaded === true,
      size: rawInfo.size,
      bytes: rawInfo.bytes,
      usage: rawInfo.usage || rawInfo.bytes,
      total_fee: totalFee,
      maxmempool: rawInfo.maxmempool,
      mempoolminfee: mempoolMinFee,
      minrelaytxfee: minRelayTxFee,
      unbroadcastcount: rawInfo.unbroadcastcount || 0,
    };
  }

  /**
   * Normalize raw transaction data to UniversalTransaction format
   */
  private normalizeRawTransaction(rawTx: any): UniversalTransaction {
    return {
      txid: rawTx.txid,
      hash: rawTx.hash,
      version: rawTx.version,
      size: rawTx.size,
      vsize: rawTx.vsize,
      weight: rawTx.weight,
      locktime: rawTx.locktime,
      vin:
        rawTx.vin?.map((vin: any) => ({
          txid: vin.txid,
          vout: vin.vout,
          scriptSig: vin.scriptSig,
          sequence: vin.sequence,
          coinbase: vin.coinbase,
          txinwitness: vin.txinwitness,
        })) || [],
      vout:
        rawTx.vout?.map((vout: any) => ({
          value: vout.value,
          n: vout.n,
          scriptPubKey: vout.scriptPubKey,
        })) || [],
      blockhash: rawTx.blockhash,
      time: rawTx.time,
      blocktime: rawTx.blocktime,
      fee: rawTx.fee,
      wtxid: rawTx.wtxid,
      depends: rawTx.depends,
      spentby: rawTx.spentby,
      bip125_replaceable: rawTx['bip125-replaceable'],
    };
  }
}
