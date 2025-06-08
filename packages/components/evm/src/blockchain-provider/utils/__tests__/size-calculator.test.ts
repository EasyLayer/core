import { BlockSizeCalculator } from '../block-size-calculator';
import type { Block, Transaction } from '../../components';

describe('BlockSizeCalculator', () => {
  // Test data
  const baseBlock: Block = {
    hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    parentHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    blockNumber: 1000,
    nonce: '0x0000000000000042',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    miner: '0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c',
    difficulty: '0x4ea3f27bc',
    totalDifficulty: '0x10b260b6f5',
    extraData: '0x476574682f4c5649562f76312e302e302f6c696e75782f676f312e342e32',
    gasLimit: 8000000,
    gasUsed: 5000000,
    timestamp: 1634567890,
    uncles: [],
    size: 0, // Will be calculated
  };

  const legacyTransaction: Transaction = {
    hash: '0xabc123def456789abc123def456789abc123def456789abc123def456789abc123',
    blockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    blockNumber: 1000,
    transactionIndex: 0,
    nonce: 42,
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
    value: '0x16345785d8a0000', // 0.1 ETH
    gas: 21000,
    input: '0x',
    type: '0x0',
    chainId: 1,
    v: '0x1c',
    r: '0xr123456789012345678901234567890123456789012345678901234567890',
    s: '0xs123456789012345678901234567890123456789012345678901234567890',
    gasPrice: '0x3b9aca00', // 1 Gwei
  };

  const eip1559Transaction: Transaction = {
    hash: '0xdef789abc123456def789abc123456def789abc123456def789abc123456def789',
    blockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    blockNumber: 1000,
    transactionIndex: 1,
    nonce: 43,
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
    value: '0x2386f26fc10000', // 0.01 ETH
    gas: 25000,
    input: '0xa9059cbb0000000000000000000000000987654321098765432109876543210987654321000000000000000000000000000000000000000000000000002386f26fc10000',
    type: '0x2',
    chainId: 1,
    v: '0x0',
    r: '0xr789012345678901234567890123456789012345678901234567890123456',
    s: '0xs789012345678901234567890123456789012345678901234567890123456',
    maxFeePerGas: '0x5d21dba00', // 25 Gwei
    maxPriorityFeePerGas: '0x1dcd6500', // 0.5 Gwei
  };

  const contractCreationTransaction: Transaction = {
    hash: '0x123abc456def789012abc456def789012abc456def789012abc456def789012abc',
    blockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    blockNumber: 1000,
    transactionIndex: 2,
    nonce: 0,
    from: '0x1234567890123456789012345678901234567890',
    to: null, // Contract creation
    value: '0x0',
    gas: 500000,
    input: '0x608060405234801561001057600080fd5b506040516108fc3803806108fc8339818101604052810190610032919061007a565b80600081905550506100a7565b600080fd5b6000819050919050565b61005a81610047565b811461006557600080fd5b50565b60008151905061007781610051565b92915050565b60008060208385031215610094576100936100425b5b600061009e85828601610068565b91505092915050565b610846806100b66000396000f3fe',
    type: '0x0',
    chainId: 1,
    v: '0x1c',
    r: '0xr456789012345678901234567890123456789012345678901234567890123',
    s: '0xs456789012345678901234567890123456789012345678901234567890123',
    gasPrice: '0x77359400', // 2 Gwei
  };

  describe('calculateBlockSize', () => {
    it('should use provided size when available and valid', () => {
      const blockWithSize = { ...baseBlock, size: 1500 };
      const result = BlockSizeCalculator.calculateBlockSize(blockWithSize);
      expect(result).toBe(1500);
      expect(blockWithSize.size).toBe(1500); // Should remain unchanged
    });

    it('should calculate and assign size when provided size is 0', () => {
      const blockWithZeroSize = { ...baseBlock, size: 0 };
      const result = BlockSizeCalculator.calculateBlockSize(blockWithZeroSize);
      expect(result).toBeGreaterThan(0);
      expect(blockWithZeroSize.size).toBe(result); // Should be assigned calculated value
    });

    it('should calculate and assign size when size is not provided', () => {
      const blockWithoutSize = { ...baseBlock };
      delete (blockWithoutSize as any).size;
      const result = BlockSizeCalculator.calculateBlockSize(blockWithoutSize);
      expect(result).toBeGreaterThan(0);
      expect(blockWithoutSize.size).toBe(result); // Should be assigned calculated value
    });

    it('should handle string size values', () => {
      const blockWithStringSize = { ...baseBlock, size: '2000' as any };
      const result = BlockSizeCalculator.calculateBlockSize(blockWithStringSize);
      expect(result).toBe(2000);
    });

    it('should calculate and assign size when provided size is null', () => {
      const blockWithNullSize = { ...baseBlock, size: null as any };
      const result = BlockSizeCalculator.calculateBlockSize(blockWithNullSize);
      expect(result).toBeGreaterThan(0);
      expect(blockWithNullSize.size).toBe(result); // Should be assigned calculated value
    });

    it('should mutate the original block object to include size', () => {
      const block = { ...baseBlock, size: 0 };
      const originalBlock = block;
      const result = BlockSizeCalculator.calculateBlockSize(block);
      
      expect(originalBlock.size).toBe(result);
      expect(originalBlock === block).toBe(true); // Same reference
    });
  });

  // describe('calculateBlockSizeFromDecodedTransactions', () => {
  //   it('should calculate size for empty block', () => {
  //     const emptyBlock = { ...baseBlock, transactions: [], size: 0 };
  //     const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(emptyBlock);
      
  //     // Should have at least header size
  //     expect(result).toBeGreaterThan(500);
  //     expect(result).toBeLessThan(2000);
  //   });

  //   it('should calculate size for block with transaction hashes only', () => {
  //     const blockWithHashes = {
  //       ...baseBlock,
  //       size: 0,
  //       transactions: [
  //         '0xhash1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
  //         '0xhash567890abcdef1234567890abcdef1234567890abcdef1234567890abcd12',
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockWithHashes);
  //     const emptyBlockSize = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions({ ...baseBlock, transactions: [], size: 0 });
      
  //     // Should add 64 bytes (2 * 32 bytes for hashes)
  //     expect(result).toBe(emptyBlockSize + 64);
  //   });

  //   it('should calculate size for block with decoded transactions', () => {
  //     const blockWithTransactions = {
  //       ...baseBlock,
  //       size: 0,
  //       transactions: [legacyTransaction, eip1559Transaction],
  //     };
      
  //     const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockWithTransactions);
  //     const emptyBlockSize = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions({ ...baseBlock, transactions: [], size: 0 });
      
  //     expect(result).toBeGreaterThan(emptyBlockSize);
  //     expect(result).toBeGreaterThan(1000);
  //   });

  //   it('should handle mixed transaction types (hashes and objects)', () => {
  //     const blockWithMixed = {
  //       ...baseBlock,
  //       size: 0,
  //       transactions: [
  //         '0xhash1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
  //         legacyTransaction,
  //         '0xhash567890abcdef1234567890abcdef1234567890abcdef1234567890abcd12',
  //         eip1559Transaction,
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockWithMixed);
  //     expect(result).toBeGreaterThan(1000);
  //   });

  //   it('should handle undefined transactions array', () => {
  //     const blockWithoutTransactions = { ...baseBlock, size: 0 };
  //     delete (blockWithoutTransactions as any).transactions;
      
  //     const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockWithoutTransactions);
  //     expect(result).toBeGreaterThan(500); // Header size only
  //   });
  // });

  // describe('calculateTransactionSize', () => {
  //   it('should calculate size for legacy transaction', () => {
  //     const result = BlockSizeCalculator.calculateTransactionSize(legacyTransaction);
      
  //     // Minimum transaction size should be 108 bytes
  //     expect(result).toBeGreaterThanOrEqual(108);
  //     expect(result).toBeLessThan(300); // Simple transaction shouldn't be too large
  //   });

  //   it('should calculate size for EIP-1559 transaction', () => {
  //     const result = BlockSizeCalculator.calculateTransactionSize(eip1559Transaction);
      
  //     expect(result).toBeGreaterThanOrEqual(108);
  //     // EIP-1559 should be larger due to additional gas fields
  //     expect(result).toBeGreaterThan(BlockSizeCalculator.calculateTransactionSize(legacyTransaction));
  //   });

  //   it('should calculate size for contract creation transaction', () => {
  //     const result = BlockSizeCalculator.calculateTransactionSize(contractCreationTransaction);
      
  //     // Should be significantly larger due to bytecode in input
  //     expect(result).toBeGreaterThan(500);
  //     expect(result).toBeGreaterThan(BlockSizeCalculator.calculateTransactionSize(legacyTransaction));
  //   });

  //   it('should handle transaction with access list', () => {
  //     const accessListTx: Transaction = {
  //       ...legacyTransaction,
  //       type: '0x1',
  //       accessList: [
  //         {
  //           address: '0x1234567890123456789012345678901234567890',
  //           storageKeys: [
  //             '0xkey1234567890123456789012345678901234567890123456789012345678901',
  //             '0xkey5678901234567890123456789012345678901234567890123456789012345',
  //           ],
  //         },
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(accessListTx);
  //     const baseResult = BlockSizeCalculator.calculateTransactionSize(legacyTransaction);
      
  //     // Should be larger due to access list
  //     expect(result).toBeGreaterThan(baseResult);
  //   });

  //   it('should handle blob transaction (EIP-4844)', () => {
  //     const blobTx: Transaction = {
  //       ...eip1559Transaction,
  //       type: '0x3',
  //       maxFeePerBlobGas: '0x77359400',
  //       blobVersionedHashes: [
  //         '0xblob1234567890123456789012345678901234567890123456789012345678901',
  //         '0xblob5678901234567890123456789012345678901234567890123456789012345',
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(blobTx);
  //     const baseResult = BlockSizeCalculator.calculateTransactionSize(eip1559Transaction);
      
  //     // Should be larger due to blob fields
  //     expect(result).toBeGreaterThan(baseResult);
  //   });

  //   it('should handle transaction with empty input', () => {
  //     const txWithEmptyInput = { ...legacyTransaction, input: '0x' };
  //     const result = BlockSizeCalculator.calculateTransactionSize(txWithEmptyInput);
      
  //     expect(result).toBeGreaterThanOrEqual(108);
  //   });

  //   it('should handle transaction without input field', () => {
  //     const txWithoutInput = { ...legacyTransaction };
  //     delete (txWithoutInput as any).input;
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(txWithoutInput);
  //     expect(result).toBeGreaterThanOrEqual(108);
  //   });
  // });

  // describe('getTransactionSizeFromHex', () => {
  //   it('should calculate size from hex string with 0x prefix', () => {
  //     const hex = '0x1234567890abcdef';
  //     const result = BlockSizeCalculator.getTransactionSizeFromHex(hex);
  //     expect(result).toBe(8); // 16 hex chars / 2 = 8 bytes
  //   });

  //   it('should calculate size from hex string without 0x prefix', () => {
  //     const hex = '1234567890abcdef';
  //     const result = BlockSizeCalculator.getTransactionSizeFromHex(hex);
  //     expect(result).toBe(8);
  //   });

  //   it('should handle empty hex string', () => {
  //     const hex = '0x';
  //     const result = BlockSizeCalculator.getTransactionSizeFromHex(hex);
  //     expect(result).toBe(0);
  //   });

  //   it('should handle odd-length hex string', () => {
  //     const hex = '0x123';
  //     const result = BlockSizeCalculator.getTransactionSizeFromHex(hex);
  //     expect(result).toBe(1); // 3 chars / 2 = 1.5, truncated to 1
  //   });
  // });

  // describe('estimateTransactionSizeFromFields', () => {
  //   it('should return minimum size for minimal transaction', () => {
  //     const minimalTx: Transaction = {
  //       hash: '0xabc',
  //       blockHash: '0xblock',
  //       blockNumber: 1000,
  //       transactionIndex: 0,
  //       nonce: 0,
  //       from: '0x1234567890123456789012345678901234567890',
  //       to: '0x0987654321098765432109876543210987654321',
  //       value: '0x0',
  //       gas: 21000,
  //       input: '0x',
  //       type: '0x0',
  //       chainId: 1,
  //       v: '0x1c',
  //       r: '0xr',
  //       s: '0xs',
  //     };
      
  //     const result = BlockSizeCalculator.estimateTransactionSizeFromFields(minimalTx);
  //     expect(result).toBe(108); // Minimum transaction size
  //   });

  //   it('should include gas price for legacy transactions', () => {
  //     const legacyTxWithGasPrice = { ...legacyTransaction };
  //     const legacyTxWithoutGasPrice = { ...legacyTransaction };
  //     delete (legacyTxWithoutGasPrice as any).gasPrice;
      
  //     const withGasPriceSize = BlockSizeCalculator.estimateTransactionSizeFromFields(legacyTxWithGasPrice);
  //     const withoutGasPriceSize = BlockSizeCalculator.estimateTransactionSizeFromFields(legacyTxWithoutGasPrice);
      
  //     expect(withGasPriceSize).toBeGreaterThan(withoutGasPriceSize);
  //   });

  //   it('should include EIP-1559 gas fields', () => {
  //     const result = BlockSizeCalculator.estimateTransactionSizeFromFields(eip1559Transaction);
  //     const legacyResult = BlockSizeCalculator.estimateTransactionSizeFromFields(legacyTransaction);
      
  //     // EIP-1559 should be larger due to additional gas fields
  //     expect(result).toBeGreaterThan(legacyResult);
  //   });

  //   it('should account for large input data', () => {
  //     const largeInputData = '0x' + 'a'.repeat(1000); // 500 bytes of data
  //     const txWithLargeInput = { ...legacyTransaction, input: largeInputData };
      
  //     const result = BlockSizeCalculator.estimateTransactionSizeFromFields(txWithLargeInput);
  //     const baseResult = BlockSizeCalculator.estimateTransactionSizeFromFields(legacyTransaction);
      
  //     expect(result).toBeGreaterThan(baseResult + 400); // Should add ~500 bytes
  //   });

  //   it('should handle contract creation (null to field)', () => {
  //     const result = BlockSizeCalculator.estimateTransactionSizeFromFields(contractCreationTransaction);
      
  //     // Should be large due to contract bytecode
  //     expect(result).toBeGreaterThan(500);
  //   });

  //   it('should include RLP encoding overhead', () => {
  //     const baseTx = { ...legacyTransaction, input: '0x' };
  //     const expectedBaseSize = 32 + 8 + 20 + 20 + 32 + 8 + 1 + 1 + 32 + 32 + 32; // Core fields
      
  //     const result = BlockSizeCalculator.estimateTransactionSizeFromFields(baseTx);
      
  //     // Should be at least 5% larger due to RLP overhead
  //     expect(result).toBeGreaterThan(expectedBaseSize);
  //   });
  // });

  // describe('estimateBlockHeaderSize', () => {
  //   it('should calculate basic header size', () => {
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(baseBlock);
      
  //     // Should be reasonable header size (typically 500-1000 bytes)
  //     expect(result).toBeGreaterThan(500);
  //     expect(result).toBeLessThan(2000);
  //   });

  //   it('should include EIP-1559 baseFeePerGas', () => {
  //     const blockWithBaseFee = { ...baseBlock, baseFeePerGas: '0x3b9aca00' };
  //     const blockWithoutBaseFee = { ...baseBlock };
      
  //     const withBaseFeeSize = BlockSizeCalculator.estimateBlockHeaderSize(blockWithBaseFee);
  //     const withoutBaseFeeSize = BlockSizeCalculator.estimateBlockHeaderSize(blockWithoutBaseFee);
      
  //     expect(withBaseFeeSize).toBeGreaterThan(withoutBaseFeeSize);
  //   });

  //   it('should include withdrawals', () => {
  //     const blockWithWithdrawals = {
  //       ...baseBlock,
  //       withdrawals: [
  //         {
  //           index: '0x1',
  //           validatorIndex: '0x1000',
  //           address: '0x1234567890123456789012345678901234567890',
  //           amount: '0x8ac7230489e80000',
  //         },
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(blockWithWithdrawals);
  //     const baseResult = BlockSizeCalculator.estimateBlockHeaderSize(baseBlock);
      
  //     expect(result).toBeGreaterThan(baseResult);
  //   });

  //   it('should include blob transaction fields', () => {
  //     const blockWithBlobs = {
  //       ...baseBlock,
  //       blobGasUsed: '0x20000',
  //       excessBlobGas: '0x0',
  //       parentBeaconBlockRoot: '0xbeef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  //     };
      
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(blockWithBlobs);
  //     const baseResult = BlockSizeCalculator.estimateBlockHeaderSize(baseBlock);
      
  //     expect(result).toBeGreaterThan(baseResult);
  //   });

  //   it('should handle variable size extraData', () => {
  //     const blockWithLargeExtraData = {
  //       ...baseBlock,
  //       extraData: '0x' + 'ff'.repeat(100), // 100 bytes of extra data
  //     };
      
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(blockWithLargeExtraData);
  //     const baseResult = BlockSizeCalculator.estimateBlockHeaderSize(baseBlock);
      
  //     expect(result).toBeGreaterThan(baseResult + 80); // Should add ~100 bytes
  //   });

  //   it('should handle empty extraData', () => {
  //     const blockWithEmptyExtraData = { ...baseBlock, extraData: '0x' };
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(blockWithEmptyExtraData);
      
  //     expect(result).toBeGreaterThan(500);
  //   });

  //   it('should include RLP encoding overhead', () => {
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(baseBlock);
      
  //     // Should include 10% RLP overhead
  //     // Calculate expected minimum size without overhead
  //     const minExpectedSize = 32 * 8 + 20 + 256 + 8 * 5; // Core fixed-size fields
  //     expect(result).toBeGreaterThan(minExpectedSize);
  //   });
  // });

  // describe('getBlockSizeBreakdown', () => {
  //   it('should provide detailed breakdown for empty block', () => {
  //     const emptyBlock = { ...baseBlock, transactions: [] };
  //     const result = BlockSizeCalculator.getBlockSizeBreakdown(emptyBlock);
      
  //     expect(result).toHaveProperty('total');
  //     expect(result).toHaveProperty('header');
  //     expect(result).toHaveProperty('transactions');
      
  //     expect(result.total).toBe(result.header + result.transactions.total);
  //     expect(result.transactions.count).toBe(0);
  //     expect(result.transactions.estimated).toBe(0);
  //     expect(result.transactions.hashOnly).toBe(0);
  //     expect(result.transactions.details).toHaveLength(0);
  //   });

  //   it('should provide breakdown for block with transaction hashes', () => {
  //     const blockWithHashes = {
  //       ...baseBlock,
  //       transactions: [
  //         '0xhash1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
  //         '0xhash567890abcdef1234567890abcdef1234567890abcdef1234567890abcd12',
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.getBlockSizeBreakdown(blockWithHashes);
      
  //     expect(result.transactions.count).toBe(2);
  //     expect(result.transactions.estimated).toBe(0);
  //     expect(result.transactions.hashOnly).toBe(2);
  //     expect(result.transactions.total).toBe(64); // 2 * 32 bytes
  //     expect(result.transactions.details).toHaveLength(2);
      
  //     result.transactions.details.forEach(detail => {
  //       expect(detail.method).toBe('hash-only');
  //       expect(detail.size).toBe(32);
  //     });
  //   });

  //   it('should provide breakdown for block with decoded transactions', () => {
  //     const blockWithTransactions = {
  //       ...baseBlock,
  //       transactions: [legacyTransaction, eip1559Transaction],
  //     };
      
  //     const result = BlockSizeCalculator.getBlockSizeBreakdown(blockWithTransactions);
      
  //     expect(result.transactions.count).toBe(2);
  //     expect(result.transactions.estimated).toBe(2);
  //     expect(result.transactions.hashOnly).toBe(0);
  //     expect(result.transactions.details).toHaveLength(2);
      
  //     result.transactions.details.forEach(detail => {
  //       expect(detail.method).toBe('estimated');
  //       expect(detail.size).toBeGreaterThanOrEqual(108);
  //       expect(detail.hash).toMatch(/^0x/);
  //     });
  //   });

  //   it('should provide breakdown for block with mixed transactions', () => {
  //     const blockWithMixed = {
  //       ...baseBlock,
  //       transactions: [
  //         '0xhash1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
  //         legacyTransaction,
  //         eip1559Transaction,
  //         '0xhash567890abcdef1234567890abcdef1234567890abcdef1234567890abcd12',
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.getBlockSizeBreakdown(blockWithMixed);
      
  //     expect(result.transactions.count).toBe(4);
  //     expect(result.transactions.estimated).toBe(2);
  //     expect(result.transactions.hashOnly).toBe(2);
  //     expect(result.transactions.details).toHaveLength(4);
      
  //     expect(result.transactions.details[0].method).toBe('hash-only');
  //     expect(result.transactions.details[1].method).toBe('estimated');
  //     expect(result.transactions.details[2].method).toBe('estimated');
  //     expect(result.transactions.details[3].method).toBe('hash-only');
  //   });

  //   it('should calculate correct totals', () => {
  //     const blockWithTransactions = {
  //       ...baseBlock,
  //       transactions: [legacyTransaction, eip1559Transaction],
  //     };
      
  //     const result = BlockSizeCalculator.getBlockSizeBreakdown(blockWithTransactions);
      
  //     expect(result.total).toBe(result.header + result.transactions.total);
      
  //     const sumOfTransactionSizes = result.transactions.details.reduce(
  //       (sum, detail) => sum + detail.size,
  //       0
  //     );
  //     expect(result.transactions.total).toBe(sumOfTransactionSizes);
  //   });
  // });

  // describe('getCalculationAccuracy', () => {
  //   it('should indicate accurate calculation when size is provided', () => {
  //     const blockWithSize = { ...baseBlock, size: 1500 };
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithSize);
      
  //     expect(result.isAccurate).toBe(true);
  //     expect(result.hasProvidedSize).toBe(true);
  //     expect(result.method).toBe('provided');
  //     expect(result.totalTransactions).toBe(0);
  //   });

  //   it('should indicate estimated calculation when size is not provided', () => {
  //     const blockWithoutSize = { ...baseBlock };
  //     delete (blockWithoutSize as any).size;
      
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithoutSize);
      
  //     expect(result.isAccurate).toBe(false);
  //     expect(result.hasProvidedSize).toBe(false);
  //     expect(result.method).toBe('estimated');
  //   });

  //   it('should indicate estimated calculation when size is 0', () => {
  //     const blockWithZeroSize = { ...baseBlock, size: 0 };
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithZeroSize);
      
  //     expect(result.isAccurate).toBe(false);
  //     expect(result.hasProvidedSize).toBe(false);
  //     expect(result.method).toBe('estimated');
  //   });

  //   it('should indicate estimated calculation when size is null', () => {
  //     const blockWithNullSize = { ...baseBlock, size: null as any };
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithNullSize);
      
  //     expect(result.isAccurate).toBe(false);
  //     expect(result.hasProvidedSize).toBe(false);
  //     expect(result.method).toBe('estimated');
  //   });

  //   it('should count transactions correctly', () => {
  //     const blockWithTransactions = {
  //       ...baseBlock,
  //       transactions: [legacyTransaction, eip1559Transaction, contractCreationTransaction],
  //     };
      
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithTransactions);
  //     expect(result.totalTransactions).toBe(3);
  //   });

  //   it('should handle undefined transactions array', () => {
  //     const blockWithoutTransactions = { ...baseBlock };
  //     delete (blockWithoutTransactions as any).transactions;
      
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithoutTransactions);
  //     expect(result.totalTransactions).toBe(0);
  //   });

  //   it('should handle string size values', () => {
  //     const blockWithStringSize = { ...baseBlock, size: '2000' as any };
  //     const result = BlockSizeCalculator.getCalculationAccuracy(blockWithStringSize);
      
  //     expect(result.isAccurate).toBe(true);
  //     expect(result.hasProvidedSize).toBe(true);
  //     expect(result.method).toBe('provided');
  //   });
  // });

  // describe('ensureBlockSize', () => {
  //   it('should calculate size for block without size', () => {
  //     const blockWithoutSize = { ...baseBlock };
  //     delete (blockWithoutSize as any).size;
      
  //     const result = BlockSizeCalculator.ensureBlockSize(blockWithoutSize);
      
  //     expect(result.size).toBeGreaterThan(0);
  //     expect(result).toBe(blockWithoutSize); // Same reference
  //   });

  //   it('should calculate size for block with zero size', () => {
  //     const blockWithZeroSize = { ...baseBlock, size: 0 };
      
  //     const result = BlockSizeCalculator.ensureBlockSize(blockWithZeroSize);
      
  //     expect(result.size).toBeGreaterThan(0);
  //     expect(result).toBe(blockWithZeroSize); // Same reference
  //   });

  //   it('should keep existing size when valid', () => {
  //     const blockWithValidSize = { ...baseBlock, size: 1500 };
      
  //     const result = BlockSizeCalculator.ensureBlockSize(blockWithValidSize);
      
  //     expect(result.size).toBe(1500);
  //     expect(result).toBe(blockWithValidSize); // Same reference
  //   });

  //   it('should calculate size for block with null size', () => {
  //     const blockWithNullSize = { ...baseBlock, size: null as any };
      
  //     const result = BlockSizeCalculator.ensureBlockSize(blockWithNullSize);
      
  //     expect(result.size).toBeGreaterThan(0);
  //     expect(typeof result.size).toBe('number');
  //   });
  // });

  // describe('Edge cases and error handling', () => {
  //   it('should handle block with null transactions', () => {
  //     const blockWithNullTransactions = { ...baseBlock, transactions: null as any, size: 0 };
  //     const result = BlockSizeCalculator.calculateBlockSize(blockWithNullTransactions);
      
  //     expect(result).toBeGreaterThan(0);
  //     expect(blockWithNullTransactions.size).toBe(result);
  //   });

  //   it('should handle transaction with extremely large input', () => {
  //     const largeInput = '0x' + 'a'.repeat(200000); // 100KB of data
  //     const txWithLargeInput = { ...legacyTransaction, input: largeInput };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(txWithLargeInput);
  //     expect(result).toBeGreaterThan(100000); // Should be at least 100KB
  //   });

  //   it('should handle block with very large number of transactions', () => {
  //     const manyTransactions = Array(1000).fill(0).map((_, i) => ({
  //       ...legacyTransaction,
  //       hash: `0x${i.toString().padStart(64, '0')}`,
  //       transactionIndex: i,
  //     }));
      
  //     const blockWithManyTx = { ...baseBlock, transactions: manyTransactions };
  //     const result = BlockSizeCalculator.calculateBlockSize(blockWithManyTx);
      
  //     expect(result).toBeGreaterThan(100000); // Should be substantial
  //   });

  //   it('should handle transaction with missing required fields gracefully', () => {
  //     const incompleteTx = {
  //       hash: '0xabc',
  //       nonce: 1,
  //       from: '0x1234567890123456789012345678901234567890',
  //       // Missing many fields
  //     } as Transaction;
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(incompleteTx);
  //     expect(result).toBeGreaterThanOrEqual(108); // Should still return minimum size
  //   });

  //   it('should handle block with extremely large extraData', () => {
  //     const largeExtraData = '0x' + 'ff'.repeat(10000); // 10KB of extra data
  //     const blockWithLargeExtra = { ...baseBlock, extraData: largeExtraData };
      
  //     const result = BlockSizeCalculator.estimateBlockHeaderSize(blockWithLargeExtra);
  //     expect(result).toBeGreaterThan(10000);
  //   });

  //   it('should handle transaction with empty access list', () => {
  //     const txWithEmptyAccessList = {
  //       ...legacyTransaction,
  //       accessList: [],
  //     };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(txWithEmptyAccessList);
  //     expect(result).toBeGreaterThanOrEqual(108);
  //   });

  //   it('should handle transaction with access list containing empty storage keys', () => {
  //     const txWithEmptyStorageKeys = {
  //       ...legacyTransaction,
  //       accessList: [
  //         {
  //           address: '0x1234567890123456789012345678901234567890',
  //           storageKeys: [],
  //         },
  //       ],
  //     };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(txWithEmptyStorageKeys);
  //     expect(result).toBeGreaterThanOrEqual(108);
  //   });

  //   it('should handle blob transaction with empty blob hashes', () => {
  //     const blobTxWithEmptyHashes = {
  //       ...eip1559Transaction,
  //       type: '0x3',
  //       maxFeePerBlobGas: '0x77359400',
  //       blobVersionedHashes: [],
  //     };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(blobTxWithEmptyHashes);
  //     expect(result).toBeGreaterThanOrEqual(108);
  //   });

  //   it('should handle negative or invalid size values', () => {
  //     const blockWithNegativeSize = { ...baseBlock, size: -100 };
  //     const result = BlockSizeCalculator.calculateBlockSize(blockWithNegativeSize);
      
  //     // Should fall back to calculation since negative size is invalid
  //     expect(result).toBeGreaterThan(0);
  //   });

  //   it('should handle transaction with malformed hex input', () => {
  //     const txWithMalformedInput = {
  //       ...legacyTransaction,
  //       input: '0xgg', // Invalid hex characters
  //     };
      
  //     // Should not throw error, even with malformed hex
  //     expect(() => {
  //       BlockSizeCalculator.calculateTransactionSize(txWithMalformedInput);
  //     }).not.toThrow();
  //   });

  //   it('should handle block with mixed valid and invalid transactions', () => {
  //     const blockWithMixedTx = {
  //       ...baseBlock,
  //       transactions: [
  //         legacyTransaction,
  //         null as any,
  //         undefined as any,
  //         eip1559Transaction,
  //         {} as Transaction, // Empty transaction object
  //       ],
  //     };
      
  //     expect(() => {
  //       BlockSizeCalculator.getBlockSizeBreakdown(blockWithMixedTx);
  //     }).not.toThrow();
  //   });
  // });

  // describe('Performance considerations', () => {
  //   it('should handle large blocks efficiently', () => {
  //     const start = Date.now();
      
  //     // Create block with 1000 transactions
  //     const manyTransactions = Array(1000).fill(0).map((_, i) => ({
  //       ...legacyTransaction,
  //       hash: `0x${i.toString().padStart(64, '0')}`,
  //       transactionIndex: i,
  //       input: '0x' + 'a'.repeat(100), // Small input data
  //     }));
      
  //     const largeBlock = { ...baseBlock, transactions: manyTransactions };
  //     const result = BlockSizeCalculator.getBlockSizeBreakdown(largeBlock);
      
  //     const duration = Date.now() - start;
      
  //     expect(result.transactions.count).toBe(1000);
  //     expect(duration).toBeLessThan(1000); // Should complete within 1 second
  //   });

  //   it('should handle transactions with large input data efficiently', () => {
  //     const start = Date.now();
      
  //     const txWithLargeInput = {
  //       ...contractCreationTransaction,
  //       input: '0x' + 'a'.repeat(100000), // 50KB of data
  //     };
      
  //     const result = BlockSizeCalculator.calculateTransactionSize(txWithLargeInput);
      
  //     const duration = Date.now() - start;
      
  //     expect(result).toBeGreaterThan(50000);
  //     expect(duration).toBeLessThan(100); // Should be very fast
  //   });
  // });

  // describe('Real-world scenarios', () => {
  //   it('should handle typical Ethereum mainnet block', () => {
  //     const typicalEthereumBlock = {
  //       ...baseBlock,
  //       blockNumber: 18000000,
  //       gasLimit: 30000000,
  //       gasUsed: 15000000,
  //       baseFeePerGas: '0x2540be400', // 10 Gwei
  //       size: 50000, // Typical block size
  //       transactions: Array(150).fill(0).map((_, i) => ({
  //         ...eip1559Transaction,
  //         hash: `0x${i.toString().padStart(64, '0')}`,
  //         transactionIndex: i,
  //         nonce: i,
  //       })),
  //     };
      
  //     const calculatedSize = BlockSizeCalculator.calculateBlockSize(typicalEthereumBlock);
  //     const breakdown = BlockSizeCalculator.getBlockSizeBreakdown(typicalEthereumBlock);
  //     const accuracy = BlockSizeCalculator.getCalculationAccuracy(typicalEthereumBlock);
      
  //     expect(calculatedSize).toBe(50000); // Should use provided size
  //     expect(breakdown.transactions.count).toBe(150);
  //     expect(accuracy.isAccurate).toBe(true);
  //     expect(accuracy.method).toBe('provided');
  //   });

  //   it('should handle BSC block with high transaction throughput', () => {
  //     const bscBlock = {
  //       ...baseBlock,
  //       blockNumber: 30000000,
  //       gasLimit: 140000000, // BSC higher gas limit
  //       gasUsed: 100000000,
  //       transactions: Array(500).fill(0).map((_, i) => ({
  //         ...legacyTransaction,
  //         hash: `0x${i.toString().padStart(64, '0')}`,
  //         transactionIndex: i,
  //         nonce: i,
  //         gasPrice: '0x12a05f200', // 5 Gwei typical for BSC
  //         chainId: 56,
  //       })),
  //     };
      
  //     const breakdown = BlockSizeCalculator.getBlockSizeBreakdown(bscBlock);
      
  //     expect(breakdown.transactions.count).toBe(500);
  //     expect(breakdown.total).toBeGreaterThan(50000);
  //   });

  //   it('should handle contract deployment transaction', () => {
  //     const contractDeployment = {
  //       ...contractCreationTransaction,
  //       gas: 2000000,
  //       gasPrice: '0x5d21dba00', // 25 Gwei
  //       input: '0x608060405234801561001057600080fd5b506040516108fc3803806108fc8339818101604052810190610032919061007a565b80600081905550506100a7565b600080fd5b6000819050919050565b61005a81610047565b811461006557600080fd5b50565b60008151905061007781610051565b92915050565b60008060208385031215610094576100936100425b5b600061009e85828601610068565b91505092915050565b610846806100b66000396000f3fe608060405234801561001057600080fd5b50600436106100365760003560e01c8063095ea7b31461003b5780631234567814610057575b600080fd5b61005560048036038101906100509190610123565b610073565b005b61005f61010b565b60405161006a919061016e565b60405180910390f35b8173ffffffffffffffffffffffffffffffffffffffff16631234567883836040518363ffffffff1660e01b81526004016100ae929190610189565b600060405180830381600087803b1580156100c857600080fd5b505af11580156100dc573d6000803e3d6000fd5b505050505050565b6000819050919050565b6100f7816100e4565b82525050565b600060208201905061011260008301846100ee565b92915050565b61012181610189565b811461012c57600080fd5b50565b60008135905061013e81610118565b92915050565b6000806040838503121561015b5761015a610113565b5b60006101698582860161012f565b925050602061017a8582860161012f565b9150509250929050565b600060408201905061019960008301856100ee565b6101a660208301846100ee565b9392505050565b600080fd5b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b60006101dd826101b2565b9050919050565b6101ed816101d2565b81146101f857600080fd5b50565b60008135905061020a816101e4565b92915050565b610219816100e4565b811461022457600080fd5b50565b60008135905061023681610210565b92915050565b6000806040838503121561025357610252610113565b5b6000610261858286016101fb565b925050602061027285828601610227565b9150509250929050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602260045260246000fd5b600060028204905060018216806102c357607f821691505b6020821081036102d6576102d561027c565b5b5091905056fea26469706673582212201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef64736f6c63430008110033',
  //     };
      
  //     const size = BlockSizeCalculator.calculateTransactionSize(contractDeployment);
      
  //     // Should be very large due to contract bytecode
  //     expect(size).toBeGreaterThan(2000);
  //   });

  //   it('should handle DeFi transaction with large calldata', () => {
  //     const defiTx = {
  //       ...eip1559Transaction,
  //       gas: 300000,
  //       to: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI token
  //       input: '0x8803dbee000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000006250c3c00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000a0b86a33e6c3fa6fc8ba5e71a5bd0d4cde6c2b3d00000000000000000000000000000000000000000000000000000000000000020000000000000000000000001f9840a85d5af5bf1d1762f925bdaddc4201f984000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  //     };
      
  //     const size = BlockSizeCalculator.calculateTransactionSize(defiTx);
      
  //     // Should be larger than simple transfer due to complex calldata
  //     expect(size).toBeGreaterThan(400);
  //   });

  //   it('should handle block with withdrawals (post-Shanghai)', () => {
  //     const postShanghaiBlock = {
  //       ...baseBlock,
  //       blockNumber: 17000000,
  //       baseFeePerGas: '0x1dcd6500', // 0.5 Gwei
  //       withdrawals: Array(16).fill(0).map((_, i) => ({
  //         index: `0x${i}`,
  //         validatorIndex: `0x${1000 + i}`,
  //         address: '0x1234567890123456789012345678901234567890',
  //         amount: '0x8ac7230489e80000', // 10 ETH in Gwei
  //       })),
  //       withdrawalsRoot: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  //       transactions: [eip1559Transaction],
  //     };
      
  //     const headerSize = BlockSizeCalculator.estimateBlockHeaderSize(postShanghaiBlock);
  //     const breakdown = BlockSizeCalculator.getBlockSizeBreakdown(postShanghaiBlock);
      
  //     expect(headerSize).toBeGreaterThan(1500); // Should be larger due to withdrawals
  //     expect(breakdown.total).toBeGreaterThan(headerSize);
  //   });

  //   it('should handle blob transaction (post-Cancun)', () => {
  //     const blobTx = {
  //       ...eip1559Transaction,
  //       type: '0x3',
  //       maxFeePerBlobGas: '0x77359400', // 2 Gwei
  //       blobVersionedHashes: [
  //         '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  //         '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  //         '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  //       ],
  //     };
      
  //     const size = BlockSizeCalculator.calculateTransactionSize(blobTx);
  //     const regularSize = BlockSizeCalculator.calculateTransactionSize(eip1559Transaction);
      
  //     expect(size).toBeGreaterThan(regularSize);
  //     expect(size).toBeGreaterThan(200); // Should account for blob fields
  //   });
  // });

  // describe('Consistency checks', () => {
  //   it('should have consistent size calculations between methods', () => {
  //     const blockWithTransactions = {
  //       ...baseBlock,
  //       transactions: [legacyTransaction, eip1559Transaction],
  //     };
      
  //     const directCalculation = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockWithTransactions);
  //     const breakdownCalculation = BlockSizeCalculator.getBlockSizeBreakdown(blockWithTransactions).total;
      
  //     expect(directCalculation).toBe(breakdownCalculation);
  //   });

  //   it('should have transaction sizes match between individual and block calculations', () => {
  //     const txSize = BlockSizeCalculator.calculateTransactionSize(legacyTransaction);
      
  //     const blockWithSingleTx = {
  //       ...baseBlock,
  //       transactions: [legacyTransaction],
  //     };
      
  //     const breakdown = BlockSizeCalculator.getBlockSizeBreakdown(blockWithSingleTx);
  //     const txSizeFromBreakdown = breakdown.transactions.details[0].size;
      
  //     expect(txSize).toBe(txSizeFromBreakdown);
  //   });

  //   it('should maintain minimum transaction size constraint', () => {
  //     const veryMinimalTx: Transaction = {
  //       hash: '0x1',
  //       blockHash: '0x1',
  //       blockNumber: 1,
  //       transactionIndex: 0,
  //       nonce: 0,
  //       from: '0x0000000000000000000000000000000000000001',
  //       to: '0x0000000000000000000000000000000000000002',
  //       value: '0x0',
  //       gas: 21000,
  //       input: '0x',
  //       type: '0x0',
  //       chainId: 1,
  //       v: '0x1b',
  //       r: '0x1',
  //       s: '0x1',
  //     };
      
  //     const size = BlockSizeCalculator.calculateTransactionSize(veryMinimalTx);
  //     expect(size).toBe(108); // Exactly minimum size
  //   });

  //   it('should handle size overflow gracefully', () => {
  //     // Create transaction with extremely large input that could cause overflow
  //     const extremeInput = '0x' + 'a'.repeat(2000000); // 1MB of data
  //     const extremeTx = { ...legacyTransaction, input: extremeInput };
      
  //     const size = BlockSizeCalculator.calculateTransactionSize(extremeTx);
      
  //     expect(size).toBeGreaterThan(1000000);
  //     expect(Number.isFinite(size)).toBe(true);
  //     expect(size).toBeGreaterThan(0);
  //   });
  // });
});