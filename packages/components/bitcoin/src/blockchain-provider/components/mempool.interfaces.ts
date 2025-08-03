export interface MempoolInfo {
  loaded: boolean; // Whether mempool is loaded
  size: number; // Number of transactions in mempool
  bytes: number; // Total size of all transactions in bytes
  usage: number; // Total memory usage for mempool in bytes
  total_fee: number; // Total fee in satoshis (converted from BTC)
  maxmempool: number; // Maximum mempool size in bytes
  mempoolminfee: number; // Minimum fee rate in sat/vB (converted from BTC/kvB)
  minrelaytxfee: number; // Minimum relay fee rate in sat/vB (converted from BTC/kvB)
  unbroadcastcount: number; // Number of unbroadcast transactions
}

export interface MempoolTransaction {
  // Basic transaction info
  txid: string;
  wtxid?: string;
  size: number;
  vsize: number;
  weight: number;
  fee: number;
  modifiedfee: number;
  time: number;
  height: number;

  // Family relationships
  depends: string[];
  descendantcount: number;
  descendantsize: number;
  descendantfees: number;
  ancestorcount: number;
  ancestorsize: number;
  ancestorfees: number;

  // Fee structure
  fees: {
    base: number;
    modified: number;
    ancestor: number;
    descendant: number;
  };

  // BIP125 RBF
  bip125_replaceable: boolean;

  // Unbroadcast flag
  unbroadcast?: boolean;
}
