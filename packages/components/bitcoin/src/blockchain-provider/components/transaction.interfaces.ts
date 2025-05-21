export interface Vin {
  txid?: string; // Transaction ID might not be present in a coinbase transaction
  vout?: number; // vout might not be present in a coinbase transaction
  scriptSig?: {
    // The script that satisfies the conditions set by the scriptPubKey from the referenced output
    asm: string; // The script in assembly format
    hex: string; // The script in hexadecimal format
  };
  sequence?: number; // The sequence number used to manage transaction replacement (Replace-by-Fee)
  coinbase?: string; // The coinbase field used only in coinbase transactions that generate new coins
}

export interface Vout {
  value: number; // The value in satoshis, representing the amount of Bitcoin
  n: number; // The index of this output in the transaction
  scriptPubKey?: {
    // The script that must be satisfied to spend this output
    asm: string; // The script in assembly format
    hex: string; // The script in hexadecimal format
    reqSigs?: number; // The number of signatures required to redeem this output
    type: string; // The type of script, such as 'pubkeyhash', 'multisig', 'nulldata', etc.
    addresses?: string[]; // The list of addresses that can redeem this output
  };
}

export interface Transaction {
  txid: string; // The transaction ID
  hash: string; // The transaction hash
  version: number; // The version of the transaction
  size: number; // The size of the transaction in bytes
  vsize: number; // The virtual size of the transaction in bytes (accounting for SegWit)
  weight: number; // The weight of the transaction used in the BIP141 weight mechanism
  locktime: number; // The locktime which specifies the earliest time when this transaction may be added to a block
  vin: Vin[]; // The array of transaction inputs
  vout: Vout[]; // The array of transaction outputs
  hex?: string; // The transaction in hexadecimal format
  blockhash?: string; // The hash of the block containing this transaction (optional, might not be available if the transaction is unconfirmed)
  confirmations?: number; // The number of confirmations for the transaction (optional, might not be available if the transaction is unconfirmed)
  time?: number; // The time the transaction was added to the block, in seconds since epoch (optional, might not be available if the transaction is unconfirmed)
  blocktime?: number; // The time the block containing the transaction was added, in seconds since epoch (optional, might not be available if the transaction is unconfirmed)
}
