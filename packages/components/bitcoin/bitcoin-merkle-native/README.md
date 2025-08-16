# @easylayer/bitcoin-merkle-native

High-performance Bitcoin Merkle tree verification using Rust with Node.js bindings via NAPI-RS.

## Performance

This Rust implementation provides **10-50x performance improvement** over pure JavaScript:

| Transaction Count | Node.js (JS) | Rust (Native) | Speedup |
|-------------------|--------------|---------------|---------|
| 1,000 txs         | ~3-5ms       | ~0.1-0.3ms    | 10-50x  |
| 10,000 txs        | ~30-50ms     | ~1-3ms        | 15-50x  |
| 100,000 txs       | ~300-500ms   | ~10-30ms      | 15-50x  |

## Features

- ✅ **Bitcoin Merkle root computation and verification**
- ✅ **SegWit witness commitment verification (BIP141)**
- ✅ **Genesis block verification**
- ✅ **Cross-platform support** (Windows, macOS, Linux)
- ✅ **Both CommonJS and ESM support**
- ✅ **TypeScript definitions included**
- ✅ **Memory-safe Rust implementation**
- ✅ **Zero runtime dependencies**

## Installation

```bash
yarn add @easylayer/bitcoin-merkle-native
```

## Usage

### CommonJS
```javascript
const { BitcoinMerkleVerifier } = require('@easylayer/bitcoin-merkle-native');

// Verify a block's merkle root
const isValid = BitcoinMerkleVerifier.verifyBlockMerkleRoot(
  block.tx,           // transactions array
  block.merkleroot,   // expected merkle root
  true               // verify witness commitment (optional)
);
```

### ESM
```javascript
import { BitcoinMerkleVerifier } from '@easylayer/bitcoin-merkle-native';

// Compute merkle root from transaction IDs
const txids = ['abc123...', 'def456...'];
const merkleRoot = BitcoinMerkleVerifier.computeMerkleRoot(txids);
```

### TypeScript
```typescript
import { BitcoinMerkleVerifier } from '@easylayer/bitcoin-merkle-native';

// Full type support
const result: boolean = BitcoinMerkleVerifier.verifyMerkleRoot(
  txids: string[], 
  expectedRoot: string
);
```

## API Reference

### Main Methods

#### `computeMerkleRoot(txidsBE: string[]): string`
Computes Merkle root from big-endian transaction IDs.

#### `verifyMerkleRoot(txidsBE: string[], expectedRootBE: string): boolean`
Verifies a Merkle root against transaction IDs.

#### `verifyBlockMerkleRoot(transactions: any[], expectedMerkleRoot: string, verifyWitness?: boolean): boolean`
**Main verification method** - verifies a complete block's Merkle root with optional SegWit witness verification.

#### `computeWitnessMerkleRoot(wtxidsBE: string[]): string`
Computes witness Merkle root for SegWit blocks (BIP141).

#### `verifyWitnessCommitment(wtxidsBE: string[], commitmentHex: string, reservedHex?: string): boolean`
Verifies BIP141 witness commitment.

### Utility Methods

#### `extractTxIds(transactions: any[]): string[]`
Extracts transaction IDs from mixed transaction array.

#### `extractWtxIds(transactions: any[]): string[]`
Extracts witness transaction IDs from mixed transaction array.

#### `verifyGenesisMerkleRoot(transactions: any[], expectedMerkleRoot: string, blockHeight?: number): boolean`
Special verification for genesis blocks.

#### `getEmptyMerkleRoot(): string`
Returns empty Merkle root (64 zeros).

## Project Structure

```
@easylayer/bitcoin-merkle-native/
├── src/
│   └── lib.rs                   # Rust implementation
├── Cargo.toml                   # Rust configuration
├── build.rs                     # Rust build script
├── index.js                     # CommonJS wrapper
├── index.mjs                    # ESM wrapper  
├── index.d.ts                   # TypeScript source definitions
├── index.*.node                 # Platform-specific binaries
└── README.md                    # This file
```