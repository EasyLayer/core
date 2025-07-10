import type { Transaction } from './transaction.interfaces';

export interface Block {
  height: number; // REQUIRED - always must be known
  hash: string;
  // ===== ENHANCED SIZE FIELDS =====
  size: number; // Full block size including witness data
  strippedsize: number; // Size WITHOUT witness data
  sizeWithoutWitnesses: number; // Alias for strippedsize for clarity
  weight: number; // Block weight (BIP 141)
  vsize: number; // Virtual block size
  witnessSize?: number; // Size of witness data only in the block
  headerSize: number; // Block header size (80 bytes)
  transactionsSize: number; // Size of all transactions
  version: number;
  versionHex: string;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: string;
  chainwork: string;
  previousblockhash?: string;
  nextblockhash?: string;
  tx?: Transaction[]; // Transaction objects only, NOT hex
  nTx?: number;
  // ===== ADDITIONAL FIELDS =====
  fee?: number;
  subsidy?: number;
  miner?: string;
  pool?: {
    poolName: string;
    url: string;
  };
  // ===== EFFICIENCY METRICS =====
  blockSizeEfficiency?: number; // Percentage of maximum block size
  witnessDataRatio?: number; // Ratio of witness data to total size
}
export interface BlockStats {
  blockhash: string;
  height: number;
  // ===== ENHANCED SIZE STATS =====
  total_size: number;
  total_stripped_size?: number; // Size without witness data
  total_witness_size?: number; // Witness data only
  total_weight?: number;
  total_vsize?: number;
  total_fee?: number;
  fee_rate_percentiles?: number[];
  subsidy?: number;
  total_out?: number;
  utxo_increase?: number;
  utxo_size_inc?: number;
  ins?: number;
  outs?: number;
  txs?: number;
  // ===== FEE STATISTICS =====
  minfee?: number;
  maxfee?: number;
  medianfee?: number;
  avgfee?: number;
  minfeerate?: number;
  maxfeerate?: number;
  medianfeerate?: number;
  avgfeerate?: number;
  // ===== TRANSACTION SIZE STATISTICS =====
  mintxsize?: number;
  maxtxsize?: number;
  mediantxsize?: number;
  avgtxsize?: number;
  // ===== WITNESS STATISTICS =====
  witness_txs?: number; // Number of SegWit transactions
  witness_ratio?: number; // Ratio of SegWit transactions to total count
}
