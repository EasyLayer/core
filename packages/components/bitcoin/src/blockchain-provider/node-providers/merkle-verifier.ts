import * as bitcoin from 'bitcoinjs-lib';

/**
 * Bitcoin Merkle Tree verification utilities for blocks and transactions
 */
export class BitcoinMerkleVerifier {
  /**
   * Computes Merkle root from array of transaction IDs
   * @param txids - Array of transaction IDs in hex format
   * @returns Computed Merkle root in hex format
   */
  static computeMerkleRoot(txids: string[]): string {
    if (!txids || txids.length === 0) {
      throw new Error('Cannot compute Merkle root from empty transaction list');
    }

    // Single transaction case
    if (txids.length === 1) {
      return txids[0]!;
    }

    // Multiple transactions - build Merkle tree
    let level = txids.map((txid) => Buffer.from(txid, 'hex').reverse());

    while (level.length > 1) {
      const nextLevel: Buffer[] = [];

      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = level[i + 1] || left; // Duplicate last if odd number

        // Combine and double hash (SHA256d)
        const combined = Buffer.concat([left, right]);
        const hash = bitcoin.crypto.sha256(bitcoin.crypto.sha256(combined));
        nextLevel.push(hash);
      }

      level = nextLevel;
    }

    // Return calculated root in standard hex format (reversed)
    return level[0]!.reverse().toString('hex');
  }

  /**
   * Verifies Merkle root against expected value
   * @param txids - Array of transaction IDs
   * @param expectedRoot - Expected Merkle root in hex format
   * @returns True if computed root matches expected root
   */
  static verifyMerkleRoot(txids: string[], expectedRoot: string): boolean {
    try {
      if (!txids || txids.length === 0) {
        // Empty block should have empty Merkle root
        return !expectedRoot || expectedRoot === '0'.repeat(64);
      }

      const computedRoot = this.computeMerkleRoot(txids);
      return computedRoot.toLowerCase() === expectedRoot.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  /**
   * Computes witness Merkle root from array of witness transaction IDs (wtxids)
   * Used for SegWit blocks to verify witness commitment
   * @param wtxids - Array of witness transaction IDs
   * @returns Computed witness Merkle root in hex format
   */
  static computeWitnessMerkleRoot(wtxids: string[]): string {
    if (!wtxids || wtxids.length === 0) {
      throw new Error('Cannot compute witness Merkle root from empty wtxids list');
    }

    // For witness Merkle root, first wtxid should be 00...00 (coinbase has no witness)
    const witnessIds = [...wtxids];
    if (witnessIds.length > 0) {
      witnessIds[0] = '0'.repeat(64); // Coinbase wtxid is always zero
    }

    return this.computeMerkleRoot(witnessIds);
  }

  /**
   * Verifies witness Merkle root for SegWit blocks
   * @param wtxids - Array of witness transaction IDs
   * @param expectedWitnessRoot - Expected witness Merkle root
   * @returns True if computed witness root matches expected
   */
  static verifyWitnessMerkleRoot(wtxids: string[], expectedWitnessRoot: string): boolean {
    try {
      if (!wtxids || wtxids.length === 0) {
        return !expectedWitnessRoot || expectedWitnessRoot === '0'.repeat(64);
      }

      const computedRoot = this.computeWitnessMerkleRoot(wtxids);
      return computedRoot.toLowerCase() === expectedWitnessRoot.toLowerCase();
    } catch (error) {
      return false;
    }
  }

  /**
   * Extracts transaction IDs from a block structure
   * Handles both string arrays and transaction objects
   * @param transactions - Block transactions (either txids or transaction objects)
   * @returns Array of transaction IDs
   */
  static extractTxIds(transactions: any[]): string[] {
    if (!transactions || transactions.length === 0) {
      return [];
    }

    return transactions
      .map((tx) => {
        if (typeof tx === 'string') {
          return tx; // Already a txid
        } else if (tx && typeof tx === 'object') {
          return tx.txid || tx.hash; // Extract txid from transaction object
        } else {
          throw new Error('Invalid transaction format in block');
        }
      })
      .filter(Boolean); // Remove any undefined values
  }

  /**
   * Extracts witness transaction IDs from a block structure
   * For SegWit blocks with full transaction objects
   * @param transactions - Block transactions with witness data
   * @returns Array of witness transaction IDs
   */
  static extractWtxIds(transactions: any[]): string[] {
    if (!transactions || transactions.length === 0) {
      return [];
    }

    return transactions
      .map((tx) => {
        if (typeof tx === 'string') {
          return tx; // Assume it's a wtxid if we only have strings
        } else if (tx && typeof tx === 'object') {
          return tx.wtxid || tx.txid || tx.hash; // Prefer wtxid, fallback to txid
        } else {
          throw new Error('Invalid transaction format in block');
        }
      })
      .filter(Boolean);
  }

  /**
   * Verifies block's Merkle root from its transaction list
   * @param block - Block object with transactions and merkleroot
   * @param verifyWitness - Whether to also verify witness commitment (SegWit)
   * @returns True if Merkle root verification passes
   */
  static verifyBlockMerkleRoot(block: any, verifyWitness: boolean = false): boolean {
    try {
      if (!block || !block.merkleroot) {
        return false;
      }

      if (!block.tx || block.tx.length === 0) {
        // Empty block case
        return block.merkleroot === '0'.repeat(64);
      }

      // Extract transaction IDs
      const txids = this.extractTxIds(block.tx);

      // Verify standard Merkle root
      const merkleValid = this.verifyMerkleRoot(txids, block.merkleroot);

      if (!merkleValid) {
        return false;
      }

      // Optionally verify witness commitment for SegWit blocks
      if (verifyWitness && block.tx.length > 0) {
        // Only verify witness if we have transaction objects (not just txids)
        const hasTransactionObjects = block.tx.some((tx: any) => typeof tx === 'object');

        if (hasTransactionObjects) {
          const wtxids = this.extractWtxIds(block.tx);

          // Look for witness commitment in coinbase transaction
          const coinbaseTx = block.tx[0];
          if (coinbaseTx && typeof coinbaseTx === 'object' && coinbaseTx.vout) {
            const witnessCommitment = this.extractWitnessCommitment(coinbaseTx);

            if (witnessCommitment) {
              return this.verifyWitnessMerkleRoot(wtxids, witnessCommitment);
            }
          }
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Extracts witness commitment from coinbase transaction
   * @param coinbaseTx - Coinbase transaction object
   * @returns Witness commitment hash or null if not found
   */
  private static extractWitnessCommitment(coinbaseTx: any): string | null {
    try {
      if (!coinbaseTx.vout || coinbaseTx.vout.length === 0) {
        return null;
      }

      // Look for OP_RETURN output with witness commitment
      for (const vout of coinbaseTx.vout) {
        if (vout.scriptPubKey && vout.scriptPubKey.hex) {
          const script = vout.scriptPubKey.hex;

          // Witness commitment: OP_RETURN + 0x24 + 0xaa21a9ed + 32-byte commitment
          if (script.startsWith('6a24aa21a9ed') && script.length === 76) {
            return script.slice(12); // Extract the 32-byte commitment
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Returns empty Merkle root (used for empty blocks)
   */
  static getEmptyMerkleRoot(): string {
    return '0'.repeat(64);
  }
}
