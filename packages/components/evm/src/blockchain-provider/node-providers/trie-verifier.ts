import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';

/**
 * Utility functions for hex/buffer conversion
 */
class HexUtils {
  static toBuf(hex: string): Uint8Array {
    if (!hex || hex === '0x') return new Uint8Array([]);
    const s = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(s.substr(i * 2, 2), 16);
    }
    return out;
  }

  static fromBuf(b: Uint8Array): string {
    return (
      '0x' +
      Array.from(b)
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('')
    );
  }
}

/**
 * EVM Merkle Trie verification utilities for transactions and receipts
 */
export class EvmTrieVerifier {
  // Empty trie root hash for EVM
  private static readonly EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

  /**
   * Computes receipts root from array of receipt objects
   * Uses post-Byzantium encoding (status instead of stateRoot)
   */
  static async computeReceiptsRoot(receipts: any[]): Promise<string> {
    if (!receipts || receipts.length === 0) {
      return this.EMPTY_TRIE_ROOT;
    }

    const trie = new Trie();

    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];

      // RLP key = RLP(index)
      const key = RLP.encode(i);

      // Process logs: [[address, topics[], data], ...]
      const logs = (receipt.logs || []).map((log: any) => [
        HexUtils.toBuf(log.address),
        (log.topics || []).map((topic: string) => HexUtils.toBuf(topic)),
        HexUtils.toBuf(log.data),
      ]);

      // Post-Byzantium encoding: [status(0/1), cumulativeGasUsed, logsBloom, logs]
      const statusInt = receipt.status === '0x1' ? 1 : 0;
      const value = RLP.encode([
        statusInt,
        HexUtils.toBuf(receipt.cumulativeGasUsed),
        HexUtils.toBuf(receipt.logsBloom),
        logs,
      ]);

      await trie.put(key, value);
    }

    return HexUtils.fromBuf(trie.root());
  }

  /**
   * Computes transactions root from array of transaction objects
   */
  static async computeTransactionsRoot(transactions: any[]): Promise<string> {
    if (!transactions || transactions.length === 0) {
      return this.EMPTY_TRIE_ROOT;
    }

    const trie = new Trie();

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];

      // Skip if transaction is just a hash string
      if (typeof tx === 'string') {
        throw new Error('Cannot compute transactions root from transaction hashes. Full transaction objects required.');
      }

      // RLP key = RLP(index)
      const key = RLP.encode(i);

      // Encode transaction based on type
      const encodedTx = this.encodeTransaction(tx);

      await trie.put(key, encodedTx);
    }

    return HexUtils.fromBuf(trie.root());
  }

  /**
   * Encodes transaction for trie based on transaction type
   */
  private static encodeTransaction(tx: any): Uint8Array {
    const txType = tx.type || '0x0';

    switch (txType) {
      case '0x0':
      case '0x1':
        // Legacy and EIP-2930 transactions
        return this.encodeLegacyTransaction(tx);
      case '0x2':
        // EIP-1559 transactions
        return this.encodeEIP1559Transaction(tx);
      case '0x3':
        // EIP-4844 blob transactions
        return this.encodeBlobTransaction(tx);
      default:
        // Fallback to legacy encoding
        return this.encodeLegacyTransaction(tx);
    }
  }

  /**
   * Encodes legacy transaction (type 0x0 and 0x1)
   */
  private static encodeLegacyTransaction(tx: any): Uint8Array {
    const fields = [
      HexUtils.toBuf(tx.nonce || '0x0'),
      HexUtils.toBuf(tx.gasPrice || '0x0'),
      HexUtils.toBuf(tx.gas || '0x0'),
      tx.to ? HexUtils.toBuf(tx.to) : new Uint8Array([]),
      HexUtils.toBuf(tx.value || '0x0'),
      HexUtils.toBuf(tx.input || '0x'),
      HexUtils.toBuf(tx.v || '0x0'),
      HexUtils.toBuf(tx.r || '0x0'),
      HexUtils.toBuf(tx.s || '0x0'),
    ];

    // Add access list for EIP-2930
    if (tx.type === '0x1' && tx.accessList) {
      const accessList = tx.accessList.map((item: any) => [
        HexUtils.toBuf(item.address),
        item.storageKeys.map((key: string) => HexUtils.toBuf(key)),
      ]);
      fields.push(accessList as any);
    }

    return RLP.encode(fields);
  }

  /**
   * Encodes EIP-1559 transaction (type 0x2)
   */
  private static encodeEIP1559Transaction(tx: any): Uint8Array {
    const fields = [
      HexUtils.toBuf(tx.chainId || '0x0'),
      HexUtils.toBuf(tx.nonce || '0x0'),
      HexUtils.toBuf(tx.maxPriorityFeePerGas || '0x0'),
      HexUtils.toBuf(tx.maxFeePerGas || '0x0'),
      HexUtils.toBuf(tx.gas || '0x0'),
      tx.to ? HexUtils.toBuf(tx.to) : new Uint8Array([]),
      HexUtils.toBuf(tx.value || '0x0'),
      HexUtils.toBuf(tx.input || '0x'),
      tx.accessList
        ? tx.accessList.map((item: any) => [
            HexUtils.toBuf(item.address),
            item.storageKeys.map((key: string) => HexUtils.toBuf(key)),
          ])
        : [],
      HexUtils.toBuf(tx.v || '0x0'),
      HexUtils.toBuf(tx.r || '0x0'),
      HexUtils.toBuf(tx.s || '0x0'),
    ];

    const encoded = RLP.encode(fields);
    // Prepend transaction type for typed transactions
    const result = new Uint8Array(encoded.length + 1);
    result[0] = 0x02;
    result.set(encoded, 1);
    return result;
  }

  /**
   * Encodes EIP-4844 blob transaction (type 0x3)
   */
  private static encodeBlobTransaction(tx: any): Uint8Array {
    const fields = [
      HexUtils.toBuf(tx.chainId || '0x0'),
      HexUtils.toBuf(tx.nonce || '0x0'),
      HexUtils.toBuf(tx.maxPriorityFeePerGas || '0x0'),
      HexUtils.toBuf(tx.maxFeePerGas || '0x0'),
      HexUtils.toBuf(tx.gas || '0x0'),
      tx.to ? HexUtils.toBuf(tx.to) : new Uint8Array([]),
      HexUtils.toBuf(tx.value || '0x0'),
      HexUtils.toBuf(tx.input || '0x'),
      tx.accessList
        ? tx.accessList.map((item: any) => [
            HexUtils.toBuf(item.address),
            item.storageKeys.map((key: string) => HexUtils.toBuf(key)),
          ])
        : [],
      HexUtils.toBuf(tx.maxFeePerBlobGas || '0x0'),
      tx.blobVersionedHashes ? tx.blobVersionedHashes.map((hash: string) => HexUtils.toBuf(hash)) : [],
      HexUtils.toBuf(tx.v || '0x0'),
      HexUtils.toBuf(tx.r || '0x0'),
      HexUtils.toBuf(tx.s || '0x0'),
    ];

    const encoded = RLP.encode(fields);
    // Prepend transaction type for typed transactions
    const result = new Uint8Array(encoded.length + 1);
    result[0] = 0x03;
    result.set(encoded, 1);
    return result;
  }

  /**
   * Verifies receipts root against expected value
   */
  static async verifyReceiptsRoot(receipts: any[], expectedRoot: string): Promise<boolean> {
    try {
      const computedRoot = await this.computeReceiptsRoot(receipts);
      return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  /**
   * Verifies transactions root against expected value
   */
  static async verifyTransactionsRoot(transactions: any[], expectedRoot: string): Promise<boolean> {
    try {
      const computedRoot = await this.computeTransactionsRoot(transactions);
      return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  /**
   * Returns empty trie root hash
   */
  static getEmptyTrieRoot(): string {
    return this.EMPTY_TRIE_ROOT;
  }
}
