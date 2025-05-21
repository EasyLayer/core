import type { Transaction } from './transaction.interfaces';

export interface Block {
  hex?: string;
  height: number; // The height of the block in the blockchain
  hash: string; // The block hash
  confirmations: number; // Number of confirmations
  strippedsize: number; // Size of the block without witness data
  size: number; // Total size of the block in bytes
  weight: number; // The weight of the block (BIP141)
  version: number; // Version of the block
  versionHex: string; // Version in hex format
  merkleroot: string; // The Merkle root of the block
  time: number; // The block time in seconds since epoch (Unix time)
  mediantime: number; // Median time of the block
  nonce: number; // Nonce used in the block
  bits: string; // The target difficulty bits in compact format
  difficulty: string; // The difficulty of the block
  chainwork: string; // Total amount of work in the chain
  previousblockhash?: string; // Hash of the previous block (if available)
  nextblockhash?: string; // Hash of the next block (if available)
  tx?: Transaction[];
}
