import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';

class HexUtils {
  static dataToBuf(value?: string | null): Uint8Array {
    if (!value || value === '0x') return new Uint8Array([]);
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
    if (!clean) return new Uint8Array([]);

    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  static quantityToBuf(value?: string | number | bigint | null): Uint8Array {
    if (value === undefined || value === null) return new Uint8Array([]);

    let numeric: bigint;
    if (typeof value === 'bigint') numeric = value;
    else if (typeof value === 'number') numeric = BigInt(value);
    else if (typeof value === 'string') {
      if (value === '0x' || value === '' || value === '0') return new Uint8Array([]);
      numeric = value.startsWith('0x') ? BigInt(value) : BigInt(value);
    } else {
      return new Uint8Array([]);
    }

    if (numeric === 0n) return new Uint8Array([]);
    const hex = numeric.toString(16);
    return this.dataToBuf(hex.length % 2 === 0 ? hex : `0${hex}`);
  }

  static fromBuf(b: Uint8Array): string {
    return `0x${Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')}`;
  }

  static yParity(value: any): Uint8Array {
    if (value === undefined || value === null || value === '0x') return new Uint8Array([]);
    const raw = typeof value === 'string' && value.startsWith('0x') ? BigInt(value) : BigInt(value);
    if (raw === 27n || raw === 28n) {
      return this.quantityToBuf(raw - 27n);
    }
    return this.quantityToBuf(raw);
  }

  static typedTransactionPrefix(typeValue: any): number | null {
    if (typeValue === undefined || typeValue === null || typeValue === '0x' || typeValue === '0x0') return null;
    const parsed = typeof typeValue === 'string' ? Number.parseInt(typeValue, 16) : Number(typeValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
}

export class EvmTrieVerifier {
  private static readonly EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

  static async computeReceiptsRoot(receipts: any[]): Promise<string> {
    if (!receipts || receipts.length === 0) {
      return this.EMPTY_TRIE_ROOT;
    }

    const trie = new Trie();

    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];
      const key = RLP.encode(i);
      const value = this.encodeReceipt(receipt);
      await trie.put(key, value);
    }

    return HexUtils.fromBuf(trie.root());
  }

  static async computeTransactionsRoot(transactions: any[]): Promise<string> {
    if (!transactions || transactions.length === 0) {
      return this.EMPTY_TRIE_ROOT;
    }

    const trie = new Trie();

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      if (typeof tx === 'string') {
        throw new Error('Cannot compute transactions root from transaction hashes. Full transaction objects required.');
      }

      const key = RLP.encode(i);
      const encodedTx = this.encodeTransaction(tx);
      await trie.put(key, encodedTx);
    }

    return HexUtils.fromBuf(trie.root());
  }

  private static encodeTransaction(tx: any): Uint8Array {
    const txType = HexUtils.typedTransactionPrefix(tx.type);

    if (txType === null) {
      return RLP.encode([
        HexUtils.quantityToBuf(tx.nonce),
        HexUtils.quantityToBuf(tx.gasPrice),
        HexUtils.quantityToBuf(tx.gas),
        tx.to ? HexUtils.dataToBuf(tx.to) : new Uint8Array([]),
        HexUtils.quantityToBuf(tx.value),
        HexUtils.dataToBuf(tx.input ?? tx.data),
        HexUtils.quantityToBuf(tx.v),
        HexUtils.quantityToBuf(tx.r),
        HexUtils.quantityToBuf(tx.s),
      ]);
    }

    const typeSpecificFields = this.encodeTypedTransactionFields(txType, tx);
    const encoded = RLP.encode(typeSpecificFields);
    const result = new Uint8Array(encoded.length + 1);
    result[0] = txType;
    result.set(encoded, 1);
    return result;
  }

  private static encodeTypedTransactionFields(txType: number, tx: any): any[] {
    const accessList = this.encodeAccessList(tx.accessList);

    if (txType === 1) {
      return [
        HexUtils.quantityToBuf(tx.chainId),
        HexUtils.quantityToBuf(tx.nonce),
        HexUtils.quantityToBuf(tx.gasPrice),
        HexUtils.quantityToBuf(tx.gas),
        tx.to ? HexUtils.dataToBuf(tx.to) : new Uint8Array([]),
        HexUtils.quantityToBuf(tx.value),
        HexUtils.dataToBuf(tx.input ?? tx.data),
        accessList,
        HexUtils.yParity(tx.yParity ?? tx.v),
        HexUtils.quantityToBuf(tx.r),
        HexUtils.quantityToBuf(tx.s),
      ];
    }

    if (txType === 2) {
      return [
        HexUtils.quantityToBuf(tx.chainId),
        HexUtils.quantityToBuf(tx.nonce),
        HexUtils.quantityToBuf(tx.maxPriorityFeePerGas),
        HexUtils.quantityToBuf(tx.maxFeePerGas),
        HexUtils.quantityToBuf(tx.gas),
        tx.to ? HexUtils.dataToBuf(tx.to) : new Uint8Array([]),
        HexUtils.quantityToBuf(tx.value),
        HexUtils.dataToBuf(tx.input ?? tx.data),
        accessList,
        HexUtils.yParity(tx.yParity ?? tx.v),
        HexUtils.quantityToBuf(tx.r),
        HexUtils.quantityToBuf(tx.s),
      ];
    }

    if (txType === 3) {
      return [
        HexUtils.quantityToBuf(tx.chainId),
        HexUtils.quantityToBuf(tx.nonce),
        HexUtils.quantityToBuf(tx.maxPriorityFeePerGas),
        HexUtils.quantityToBuf(tx.maxFeePerGas),
        HexUtils.quantityToBuf(tx.gas),
        tx.to ? HexUtils.dataToBuf(tx.to) : new Uint8Array([]),
        HexUtils.quantityToBuf(tx.value),
        HexUtils.dataToBuf(tx.input ?? tx.data),
        accessList,
        HexUtils.quantityToBuf(tx.maxFeePerBlobGas),
        Array.isArray(tx.blobVersionedHashes)
          ? tx.blobVersionedHashes.map((hash: string) => HexUtils.dataToBuf(hash))
          : [],
        HexUtils.yParity(tx.yParity ?? tx.v),
        HexUtils.quantityToBuf(tx.r),
        HexUtils.quantityToBuf(tx.s),
      ];
    }

    if (txType === 4) {
      return [
        HexUtils.quantityToBuf(tx.chainId),
        HexUtils.quantityToBuf(tx.nonce),
        HexUtils.quantityToBuf(tx.maxPriorityFeePerGas),
        HexUtils.quantityToBuf(tx.maxFeePerGas),
        HexUtils.quantityToBuf(tx.gas),
        tx.to ? HexUtils.dataToBuf(tx.to) : new Uint8Array([]),
        HexUtils.quantityToBuf(tx.value),
        HexUtils.dataToBuf(tx.input ?? tx.data),
        accessList,
        this.encodeAuthorizationList(tx.authorizationList ?? tx.authorization_list),
        HexUtils.yParity(tx.yParity ?? tx.v),
        HexUtils.quantityToBuf(tx.r),
        HexUtils.quantityToBuf(tx.s),
      ];
    }

    return [
      HexUtils.quantityToBuf(tx.nonce),
      HexUtils.quantityToBuf(tx.gasPrice),
      HexUtils.quantityToBuf(tx.gas),
      tx.to ? HexUtils.dataToBuf(tx.to) : new Uint8Array([]),
      HexUtils.quantityToBuf(tx.value),
      HexUtils.dataToBuf(tx.input ?? tx.data),
      HexUtils.quantityToBuf(tx.v),
      HexUtils.quantityToBuf(tx.r),
      HexUtils.quantityToBuf(tx.s),
    ];
  }

  private static encodeReceipt(receipt: any): Uint8Array {
    const logs = (receipt.logs || []).map((log: any) => [
      HexUtils.dataToBuf(log.address),
      (log.topics || []).map((topic: string) => HexUtils.dataToBuf(topic)),
      HexUtils.dataToBuf(log.data),
    ]);

    const payload = RLP.encode([
      receipt.root ? HexUtils.dataToBuf(receipt.root) : HexUtils.quantityToBuf(receipt.status ?? 0),
      HexUtils.quantityToBuf(receipt.cumulativeGasUsed),
      HexUtils.dataToBuf(receipt.logsBloom),
      logs,
    ]);

    const receiptType = HexUtils.typedTransactionPrefix(receipt.type);
    if (receiptType === null) {
      return payload;
    }

    const encoded = new Uint8Array(payload.length + 1);
    encoded[0] = receiptType;
    encoded.set(payload, 1);
    return encoded;
  }

  private static encodeAccessList(accessList: any): any[] {
    if (!Array.isArray(accessList)) return [];
    return accessList.map((item: any) => [
      HexUtils.dataToBuf(item.address),
      Array.isArray(item.storageKeys) ? item.storageKeys.map((key: string) => HexUtils.dataToBuf(key)) : [],
    ]);
  }

  private static encodeAuthorizationList(authList: any): any[] {
    if (!Array.isArray(authList)) return [];
    return authList.map((item: any) => [
      HexUtils.quantityToBuf(item.chainId ?? item.chain_id),
      HexUtils.dataToBuf(item.address),
      HexUtils.quantityToBuf(item.nonce),
      HexUtils.yParity(item.yParity ?? item.y_parity ?? item.v),
      HexUtils.quantityToBuf(item.r),
      HexUtils.quantityToBuf(item.s),
    ]);
  }

  static async verifyReceiptsRoot(receipts: any[], expectedRoot: string): Promise<boolean> {
    try {
      const computedRoot = await this.computeReceiptsRoot(receipts);
      return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
    } catch {
      return false;
    }
  }

  static async verifyTransactionsRoot(transactions: any[], expectedRoot: string): Promise<boolean> {
    try {
      const computedRoot = await this.computeTransactionsRoot(transactions);
      return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
    } catch {
      return false;
    }
  }

  static getEmptyTrieRoot(): string {
    return this.EMPTY_TRIE_ROOT;
  }
}
