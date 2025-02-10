export interface Block {
  number: number; // Block number (height)
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
  baseFeePerGas?: string; // Optional: Base fee per gas (in wei) for EIP-1559 blocks
}
