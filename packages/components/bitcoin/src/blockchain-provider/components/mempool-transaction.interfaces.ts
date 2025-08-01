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
