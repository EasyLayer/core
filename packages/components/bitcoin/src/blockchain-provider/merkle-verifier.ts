// import * as bitcoin from 'bitcoinjs-lib';

// // ============================================================
// //  BitcoinMerkleVerifier
// //  ------------------------------------------------------------
// //  - Input txids/wtxids are BE hex (as returned by RPC).
// //  - Merkle tree MUST be built over LITTLE-ENDIAN bytes.
// //  - On each level: concat(leftLE || rightLE) -> double-SHA256.
// //  - If odd number of leaves, duplicate the last.
// //  - Final root converted back to BE for RPC-style comparison.
// //  - Witness commitment per BIP141:
// //      commitment = SHA256( SHA256( witness_root_LE || witness_reserved_32 ) )
// //    and stored in coinbase vout as:
// //      OP_RETURN 0x24 aa21a9ed <32-byte commitment>
// // ============================================================

// function hexBEtoBufLE(hexBE: string): Buffer {
//   // RPC prints big-endian; internal hashing uses little-endian.
//   return Buffer.from(hexBE.match(/../g)!.reverse().join(''), 'hex');
// }

// function bufLEtoHexBE(bufLE: Buffer): string {
//   return Buffer.from(bufLE).reverse().toString('hex');
// }

// function dsha256(buf: Buffer): Buffer {
//   return bitcoin.crypto.sha256(bitcoin.crypto.sha256(buf));
// }

// export class BitcoinMerkleVerifier {
//   /**
//    * Compute Merkle root from BE txids (as read from RPC).
//    * Internally converts each txid to LE before hashing.
//    * Returns BE hex to compare with RPC `merkleroot`.
//    */
//   static computeMerkleRoot(txidsBE: string[]): string {
//     if (!txidsBE || txidsBE.length === 0) {
//       throw new Error('Cannot compute Merkle root from empty transaction list');
//     }
//     if (txidsBE.length === 1) {
//       // With a single transaction, merkleroot (RPC) equals the txid (both BE).
//       return txidsBE[0]!.toLowerCase();
//     }

//     // Build tree in LE
//     let level = txidsBE.map(hexBEtoBufLE);

//     while (level.length > 1) {
//       const next: Buffer[] = [];
//       for (let i = 0; i < level.length; i += 2) {
//         const left = level[i]!;
//         const right = level[i + 1] ?? left; // duplicate last if odd
//         next.push(dsha256(Buffer.concat([left, right])));
//       }
//       level = next;
//     }

//     // Convert final root back to BE for RPC comparison
//     return bufLEtoHexBE(level[0]!).toLowerCase();
//   }

//   /**
//    * Verify block merkleroot (both BE hex).
//    *
//    * Performance (Node.js):
//    * - 1,000 txs: ~3-5ms total
//    * - 5,000 txs: ~15-25ms total
//    * - 10,000 txs: ~30-50ms total
//    * - 50,000 txs: ~150-250ms total
//    * - 100,000 txs: ~300-500ms total (very large blocks)
//    */
//   static verifyMerkleRoot(txidsBE: string[], expectedRootBE: string): boolean {
//     try {
//       if (!expectedRootBE) return false;
//       if (!txidsBE || txidsBE.length === 0) {
//         // No transactions -> expect the "empty" root (conventionally zeros)
//         return expectedRootBE === '0'.repeat(64);
//       }
//       const computed = this.computeMerkleRoot(txidsBE);
//       return computed === expectedRootBE.toLowerCase();
//     } catch {
//       return false;
//     }
//   }

//   /**
//    * Compute witness Merkle root from BE wtxids.
//    * Per BIP141, coinbase wtxid is all zeros (32 bytes).
//    * Returns BE hex.
//    */
//   static computeWitnessMerkleRoot(wtxidsBE: string[]): string {
//     if (!wtxidsBE || wtxidsBE.length === 0) {
//       throw new Error('Cannot compute witness Merkle root from empty wtxids list');
//     }
//     const ids = [...wtxidsBE];
//     ids[0] = '0'.repeat(64); // coinbase wtxid = 32 zero bytes
//     return this.computeMerkleRoot(ids);
//   }

//   /**
//    * Verify BIP141 witness commitment embedded in coinbase.
//    * commitment = SHA256( SHA256( witness_root_LE || reserved32 ) )
//    * The 32-byte commitment is found in OP_RETURN: 6a24aa21a9ed <commitment>
//    *
//    * NOTE: if witness doesnt exist - will return true
//    *
//    * Performance (Node.js):
//    * - 1,000 txs: ~3-6ms total
//    * - 5,000 txs: ~15-30ms total
//    * - 10,000 txs: ~30-55ms total
//    * - 50,000 txs: ~150-275ms total
//    * - 100,000 txs: ~300-550ms total
//    */
//   static verifyWitnessCommitment(block: any): boolean {
//     try {
//       // No transactions -> nothing to verify
//       if (!block?.tx?.length) return true; // N/A = true

//       // Extract witness commitment from coinbase
//       const commitmentHex = this.extractWitnessCommitmentFromCoinbase(block.tx[0]);
//       if (!commitmentHex) {
//         // No commitment -> network/block does not use SegWit or commitment is missing
//         return true; // N/A = true
//       }

//       // Extract wtxids (BE hex). If missing -> nothing to verify
//       const wtxids = this.extractWtxIds(block.tx);
//       if (!wtxids.length) return true; // N/A = true

//       // Compute witness merkle root
//       const witnessRootBE = this.computeWitnessMerkleRoot(wtxids);
//       const witnessRootLE = hexBEtoBufLE(witnessRootBE);

//       // Extract reserved value (often all zeros)
//       const reserved = this.extractWitnessReservedValue(block.tx[0]) ?? Buffer.alloc(32, 0x00);

//       // BIP141: commitment = SHA256( SHA256( witness_root_LE || witness_reserved_32 ) )
//       const calc = dsha256(Buffer.concat([witnessRootLE, reserved])).toString('hex');

//       return calc.toLowerCase() === commitmentHex.toLowerCase();
//     } catch {
//       return false;
//     }
//   }

//   /**
//    * Extract txids (BE hex) from RPC-like mixed array (strings or objects).
//    */
//   static extractTxIds(transactions: any[]): string[] {
//     return (transactions ?? [])
//       .map((tx) => (typeof tx === 'string' ? tx : tx?.txid ?? tx?.hash))
//       .filter(Boolean)
//       .map((s: string) => s.toLowerCase());
//   }

//   /**
//    * Extract wtxids (BE hex). Fallback to txid/hash if wtxid missing.
//    */
//   static extractWtxIds(transactions: any[]): string[] {
//     return (transactions ?? [])
//       .map((tx) => (typeof tx === 'string' ? tx : tx?.wtxid ?? tx?.txid ?? tx?.hash))
//       .filter(Boolean)
//       .map((s: string) => s.toLowerCase());
//   }

//   /**
//    * Verify a whole block's merkleroot; optionally verify witness commitment (SegWit).
//    * Works across BTC/BCH/LTC/DOGE; witness check only applies where present.
//    *
//    * Performance (Node.js) - MAIN VERIFICATION METHOD:
//    * WITHOUT witness verification:
//    * - 1,000 txs: ~3-5ms
//    * - 5,000 txs: ~15-25ms
//    * - 10,000 txs: ~30-50ms
//    * - 50,000 txs: ~150-250ms
//    * - 100,000 txs: ~300-500ms (0.3-0.5 seconds)
//    *
//    * WITH witness verification (verifyWitness=true):
//    * - 1,000 txs: ~6-12ms
//    * - 5,000 txs: ~30-55ms
//    * - 10,000 txs: ~60-110ms
//    * - 50,000 txs: ~300-525ms
//    * - 100,000 txs: ~600-1000ms (0.6-1 second)
//    */
//   static verifyBlockMerkleRoot(block: any, verifyWitness = false): boolean {
//     try {
//       if (!block?.merkleroot) return false;

//       const txids = this.extractTxIds(block.tx ?? []);
//       if (txids.length === 0) {
//         return block.merkleroot === '0'.repeat(64);
//       }

//       if (!this.verifyMerkleRoot(txids, block.merkleroot)) {
//         return false;
//       }

//       if (verifyWitness && (block.tx?.length ?? 0) > 0) {
//         // Only meaningful on SegWit-capable networks/blocks
//         const hasObjects = block.tx.some((tx: any) => typeof tx === 'object');
//         if (hasObjects) {
//           return this.verifyWitnessCommitment(block);
//         }
//       }
//       return true;
//     } catch {
//       return false;
//     }
//   }

//   /**
//    * Genesis helper: at height 0 with exactly one tx, merkleroot must equal that txid (both BE).
//    */
//   static verifyGenesisMerkleRoot(block: any): boolean {
//     try {
//       if (!block || block.height !== 0) throw new Error('Not a genesis block');
//       if (!block.merkleroot) return false;
//       const txids = this.extractTxIds(block.tx ?? []);
//       if (txids.length !== 1) return false;
//       return block.merkleroot.toLowerCase() === txids[0]!.toLowerCase();
//     } catch {
//       return false;
//     }
//   }

//   // --- Internals for witness commitment extraction ---

//   private static extractWitnessCommitmentFromCoinbase(coinbaseTx: any): string | null {
//     // Looks for: OP_RETURN (6a) + push(0x24) + aa21a9ed + <32-byte commitment>
//     for (const vout of coinbaseTx?.vout ?? []) {
//       const script: string | undefined = vout?.scriptPubKey?.hex;
//       if (script?.startsWith('6a24aa21a9ed') && script.length >= 12 + 64) {
//         return script.slice(12, 12 + 64);
//       }
//     }
//     return null;
//   }

//   private static extractWitnessReservedValue(coinbaseTx: any): Buffer | null {
//     // Usually the last 32-byte element in the coinbase input's witness stack (often all zeros).
//     const w = coinbaseTx?.vin?.[0]?.txinwitness;
//     if (!Array.isArray(w)) return null;
//     for (let i = w.length - 1; i >= 0; i--) {
//       const item = w[i];
//       if (typeof item === 'string' && item.length === 64) {
//         return Buffer.from(item, 'hex');
//       }
//     }
//     return null;
//   }

//   static getEmptyMerkleRoot(): string {
//     return '0'.repeat(64);
//   }
// }

import type { Transaction } from '@easylayer/bitcoin-merkle-native';
import { BitcoinMerkleVerifier } from '@easylayer/bitcoin-merkle-native';

export class BitcoinMerkleVerifierWrapper {
  static computeMerkleRoot(txidsBE: string[]): string {
    return BitcoinMerkleVerifier.computeMerkleRoot(txidsBE);
  }

  static verifyMerkleRoot(txidsBE: string[], expectedRootBE: string): boolean {
    return BitcoinMerkleVerifier.verifyMerkleRoot(txidsBE, expectedRootBE);
  }

  static computeWitnessMerkleRoot(wtxidsBE: string[]): string {
    return BitcoinMerkleVerifier.computeWitnessMerkleRoot(wtxidsBE);
  }

  /**
   * Main method - converts JS block format to Rust format
   */
  static verifyBlockMerkleRoot(block: any, verifyWitness = false): boolean {
    if (!block?.merkleroot) return false;

    const transactions = block.tx || [];
    if (transactions.length === 0) {
      return block.merkleroot === '0'.repeat(64);
    }

    // Convert JS transactions to Rust format
    const rustTransactions = this.convertTransactionsToRustFormat(transactions);

    // Extract witness data if needed
    let witnessCommitment: string | undefined;
    let witnessReserved: string | undefined;

    if (verifyWitness && transactions.length > 0) {
      witnessCommitment = this.extractWitnessCommitmentFromCoinbase(transactions[0]);
      witnessReserved = this.extractWitnessReservedValue(transactions[0]);
    }

    return BitcoinMerkleVerifier.verifyBlockMerkleRoot(
      rustTransactions,
      block.merkleroot,
      verifyWitness,
      witnessCommitment,
      witnessReserved
    );
  }

  static verifyGenesisMerkleRoot(block: any): boolean {
    const transactions = this.convertTransactionsToRustFormat(block.tx || []);

    return BitcoinMerkleVerifier.verifyGenesisMerkleRoot(transactions, block.merkleroot || '', block.height);
  }

  /**
   * Convert JS transaction format to Rust Either<String, Transaction> format
   */
  private static convertTransactionsToRustFormat(transactions: any[]): Array<string | Transaction> {
    return transactions.map((tx) => {
      if (typeof tx === 'string') {
        return tx; // Already a string
      }

      // Convert object to Transaction interface
      const rustTx: Transaction = {
        txid: tx.txid || tx.hash || undefined,
        wtxid: tx.wtxid || undefined,
        hash: tx.hash || undefined,
      };

      return rustTx;
    });
  }

  /**
   * Utility methods using native implementation
   */
  static extractTxIds(transactions: any[]): string[] {
    const rustTransactions = this.convertTransactionsToRustFormat(transactions);
    return BitcoinMerkleVerifier.extractTxIds(rustTransactions);
  }

  static extractWtxIds(transactions: any[]): string[] {
    const rustTransactions = this.convertTransactionsToRustFormat(transactions);
    return BitcoinMerkleVerifier.extractWtxIds(rustTransactions);
  }

  static getEmptyMerkleRoot(): string {
    return BitcoinMerkleVerifier.getEmptyMerkleRoot();
  }

  /**
   * Legacy helper methods for witness extraction (still needed for conversion)
   */
  private static extractWitnessCommitmentFromCoinbase(coinbaseTx: any): string | undefined {
    for (const vout of coinbaseTx?.vout ?? []) {
      const script: string | undefined = vout?.scriptPubKey?.hex;
      if (script?.startsWith('6a24aa21a9ed') && script.length >= 12 + 64) {
        return script.slice(12, 12 + 64);
      }
    }
    return undefined;
  }

  private static extractWitnessReservedValue(coinbaseTx: any): string | undefined {
    const w = coinbaseTx?.vin?.[0]?.txinwitness;
    if (!Array.isArray(w)) return undefined;

    for (let i = w.length - 1; i >= 0; i--) {
      const item = w[i];
      if (typeof item === 'string' && item.length === 64) {
        return item;
      }
    }
    return undefined;
  }
}
