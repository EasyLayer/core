import type { Transaction } from './transaction.interfaces';

export interface Withdrawal {
  index: string; // Withdrawal index (hex string)
  validatorIndex: string; // Validator index (hex string)
  address: string; // Withdrawal recipient address
  amount: string; // Withdrawal amount in Gwei (hex string)
}

export interface Block {
  hex?: string;
  blockNumber: number; // Block number (height)
  hash: string; // Block hash
  parentHash: string; // Parent block hash
  nonce: string; // Block nonce (in hex)
  sha3Uncles: string; // Keccak-256 hash of uncles
  logsBloom: string; // Logs bloom filter
  transactionsRoot: string; // Root hash of the transactions Merkle tree
  stateRoot: string; // Root hash of the state tree
  receiptsRoot: string; // Root hash of the receipts tree
  miner: string; // Miner (coinbase) address
  difficulty: string; // Block difficulty
  totalDifficulty: string; // Total difficulty of the chain up to this block
  extraData: string; // Extra data (in hex)
  size: number; // Total block size in bytes
  gasLimit: number; // Block gas limit
  gasUsed: number; // Gas used in the block
  timestamp: number; // Block timestamp (Unix time)
  uncles: string[]; // Array of uncle block hashes

  // EIP-1559 fields (added in London fork, August 2021)
  baseFeePerGas?: string; // Base fee per gas (in wei) for EIP-1559 blocks

  // Shanghai fork fields (added March 2023, enables staking withdrawals)
  withdrawals?: Withdrawal[]; // Array of validator withdrawals
  withdrawalsRoot?: string; // Root hash of withdrawals tree

  // Cancun fork fields (added March 2024, enables blob transactions)
  blobGasUsed?: string; // Total blob gas used in block (hex string)
  excessBlobGas?: string; // Excess blob gas from previous block (hex string)
  parentBeaconBlockRoot?: string; // Parent beacon block root hash

  transactions?: Transaction[];
}
