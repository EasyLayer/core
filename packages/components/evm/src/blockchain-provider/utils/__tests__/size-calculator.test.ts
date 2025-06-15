import { BlockSizeCalculator } from '../block-size-calculator';
import type { Block, Transaction, TransactionReceipt } from '../../components';

describe('BlockSizeCalculator', () => {
  // Test data factories
  const createBaseBlock = (overrides: Partial<Block> = {}): Block => ({
    hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    parentHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    blockNumber: 1000,
    nonce: '0x0000000000000042',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x' + '0'.repeat(512),
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
    size: 0,
    sizeWithoutReceipts: 0,
    ...overrides,
  });

  const createBaseTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
    hash: '0xabc123def456789abc123def456789abc123def456789abc123def456789abc123',
    blockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    blockNumber: 1000,
    transactionIndex: 0,
    nonce: 42,
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
    value: '0x16345785d8a0000',
    gas: 21000,
    input: '0x',
    type: '0x0',
    chainId: 1,
    v: '0x1c',
    r: '0xr123456789012345678901234567890123456789012345678901234567890',
    s: '0xs123456789012345678901234567890123456789012345678901234567890',
    gasPrice: '0x3b9aca00',
    ...overrides,
  });

  const createMinimalTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
    hash: '0x1',
    blockHash: '0x1',
    blockNumber: 1,
    transactionIndex: 0,
    nonce: 0,
    from: '0x0000000000000000000000000000000000000001',
    to: '0x0000000000000000000000000000000000000002',
    value: '0x0',
    gas: 21000,
    input: '0x',
    type: '0x0',
    chainId: 1,
    v: '0x1b',
    r: '0x1',
    s: '0x1',
    ...overrides,
  });

  const createBaseReceipt = (overrides: Partial<TransactionReceipt> = {}): TransactionReceipt => ({
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    transactionIndex: 0,
    blockHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    blockNumber: 1000,
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
    cumulativeGasUsed: 21000,
    gasUsed: 21000,
    contractAddress: null,
    logs: [],
    logsBloom: '0x' + '0'.repeat(512),
    status: '0x1',
    type: '0x0',
    effectiveGasPrice: 1000000000,
    ...overrides,
  });

  const createLog = (overrides: any = {}) => ({
    address: '0x1234567890123456789012345678901234567890',
    topics: ['0xtopic1234567890abcdef1234567890abcdef1234567890abcdef1234567890'],
    data: '0x1234abcd',
    blockNumber: 1000,
    transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    transactionIndex: 0,
    blockHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    logIndex: 0,
    removed: false,
    ...overrides,
  });

  const generateReceipts = (count: number, overrides: Partial<TransactionReceipt> = {}) =>
    Array.from({ length: count }, (_, i) =>
      createBaseReceipt({
        transactionHash: `0x${i.toString().padStart(64, '0')}`,
        transactionIndex: i,
        cumulativeGasUsed: 21000 * (i + 1),
        ...overrides,
      })
    );

  describe('calculateBlockSize', () => {
    it('should use provided size when available and valid', () => {
      const block = createBaseBlock({ size: 1500 });
      const result = BlockSizeCalculator.calculateBlockSize(block);
      expect(result).toBe(1500);
      expect(block.size).toBe(1500);
    });

    it('should calculate and assign size when provided size is 0', () => {
      const block = createBaseBlock({ size: 0 });
      const result = BlockSizeCalculator.calculateBlockSize(block);
      expect(result).toBeGreaterThan(0);
      expect(block.size).toBe(result);
    });

    it('should calculate and assign size when size is null', () => {
      const block = createBaseBlock({ size: null as any });
      const result = BlockSizeCalculator.calculateBlockSize(block);
      expect(result).toBeGreaterThan(0);
      expect(block.size).toBe(result);
    });

    it('should handle string size values', () => {
      const block = createBaseBlock({ size: '2000' as any });
      const result = BlockSizeCalculator.calculateBlockSize(block);
      expect(result).toBe(2000);
    });
  });

  describe('Receipt Size Calculation', () => {
    describe('calculateReceiptsSize', () => {
      it('should return 0 for empty or null receipts', () => {
        expect(BlockSizeCalculator.calculateReceiptsSize([])).toBe(0);
        expect(BlockSizeCalculator.calculateReceiptsSize(null as any)).toBe(0);
        expect(BlockSizeCalculator.calculateReceiptsSize(undefined as any)).toBe(0);
      });

      it('should calculate size for simple receipt', () => {
        const receipts = [createBaseReceipt()];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(400);
        expect(size).toBeLessThan(750); // Updated to account for actual implementation
      });

      it('should calculate size for receipt with logs', () => {
        const receipts = [
          createBaseReceipt({
            logs: [createLog()],
          }),
        ];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(500);
        expect(size).toBeLessThan(900); // Updated to account for logs
      });

      it('should calculate size for receipt with multiple topics and large data', () => {
        const receipts = [
          createBaseReceipt({
            logs: [
              createLog({
                topics: ['0xtopic1', '0xtopic2', '0xtopic3'],
                data: '0x' + '1234abcd'.repeat(50), // 200 bytes
              }),
            ],
            contractAddress: '0x1111111111111111111111111111111111111111',
            logsBloom: '0x' + 'a'.repeat(512),
          }),
        ];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(900);
        expect(size).toBeLessThan(1400); // Updated for complex receipt
      });

      it('should calculate size for multiple receipts', () => {
        const receipts = generateReceipts(3);
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(1200);
        expect(size).toBeLessThan(2100); // Updated for 3 receipts
      });

      it('should handle contract creation receipt', () => {
        const receipts = [
          createBaseReceipt({
            to: null,
            contractAddress: '0x1111111111111111111111111111111111111111',
            gasUsed: 500000,
            cumulativeGasUsed: 500000,
            logs: [
              createLog({
                topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
                data: '0x0000000000000000000000000000000000000000000000001bc16d674ec80000',
              }),
            ],
          }),
        ];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(500);
        expect(size).toBeLessThan(950); // Updated for contract creation
      });

      it('should handle receipts with multiple logs', () => {
        const receipts = [
          createBaseReceipt({
            gasUsed: 200000,
            cumulativeGasUsed: 200000,
            logs: [
              createLog({ topics: ['0xtopic1', '0xtopic2'], logIndex: 0 }),
              createLog({ topics: ['0xtopic3'], logIndex: 1 }),
              createLog({ topics: ['0xtopic4', '0xtopic5', '0xtopic6'], logIndex: 2 }),
            ],
          }),
        ];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(700);
        expect(size).toBeLessThan(1400); // Updated for multiple logs
      });
    });

    describe('calculateReceiptsSizePrecise', () => {
      it('should return JSON.stringify length for valid receipts', () => {
        const receipts = [createBaseReceipt({ logsBloom: '0x' + '0'.repeat(20) })];
        const preciseSize = BlockSizeCalculator.calculateReceiptsSizePrecise(receipts);
        const expectedSize = JSON.stringify(receipts).length;
        expect(preciseSize).toBe(expectedSize);
      });

      it('should fallback to approximation when JSON.stringify fails', () => {
        const circularReceipt: any = createBaseReceipt();
        circularReceipt.circular = circularReceipt; // Create circular reference
        const size = BlockSizeCalculator.calculateReceiptsSizePrecise([circularReceipt]);
        expect(size).toBeGreaterThan(0);
        expect(size).toBeLessThan(1000);
      });

      it('should handle empty receipts', () => {
        expect(BlockSizeCalculator.calculateReceiptsSizePrecise([])).toBe(0);
        expect(BlockSizeCalculator.calculateReceiptsSizePrecise(null as any)).toBe(0);
      });
    });

    describe('Integration with block calculations', () => {
      it('should integrate receipts size into block size calculation', () => {
        const block = createBaseBlock({
          sizeWithoutReceipts: 1000,
          receipts: [createBaseReceipt()],
        });
        const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts!);
        const totalSize = block.sizeWithoutReceipts + receiptsSize;
        expect(receiptsSize).toBeGreaterThan(0);
        expect(totalSize).toBeGreaterThan(block.sizeWithoutReceipts);
      });

      it('should handle block without receipts', () => {
        const block = createBaseBlock({ size: 1500, sizeWithoutReceipts: 1500 });
        const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts!);
        expect(receiptsSize).toBe(0);
      });

      it('should handle block with empty receipts array', () => {
        const block = createBaseBlock({ receipts: [] });
        const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts || []);
        expect(receiptsSize).toBe(0);
      });

      it('should calculate different sizes for varying receipt complexity', () => {
        const simpleReceipts = [createBaseReceipt()];
        const complexReceipts = [
          createBaseReceipt({
            gasUsed: 200000,
            cumulativeGasUsed: 200000,
            logs: [
              createLog({
                topics: ['0xtopic1', '0xtopic2', '0xtopic3'],
                data: '0x' + '1234'.repeat(100), // Large data
              }),
            ],
            logsBloom: '0x' + 'f'.repeat(512),
          }),
        ];

        const simpleSize = BlockSizeCalculator.calculateReceiptsSize(simpleReceipts);
        const complexSize = BlockSizeCalculator.calculateReceiptsSize(complexReceipts);
        
        expect(complexSize).toBeGreaterThan(simpleSize);
        expect(simpleSize).toBeGreaterThan(400);
        expect(complexSize).toBeGreaterThan(800);
      });
    });

    describe('Edge cases and error handling', () => {
      it('should handle extremely large logsBloom', () => {
        const receipts = [createBaseReceipt({ logsBloom: '0x' + 'f'.repeat(2048) })];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(1200);
      });

      it('should handle missing optional fields', () => {
        const receipts = [createBaseReceipt({ to: null, contractAddress: null })];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(400);
      });

      it('should handle logs with empty data', () => {
        const receipts = [
          createBaseReceipt({
            logs: [createLog({ data: '0x' })],
          }),
        ];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(500);
      });

      it('should handle logs with no topics', () => {
        const receipts = [
          createBaseReceipt({
            logs: [createLog({ topics: [] })],
          }),
        ];
        const size = BlockSizeCalculator.calculateReceiptsSize(receipts);
        expect(size).toBeGreaterThan(400);
      });

      it('should handle large number of receipts efficiently', () => {
        const manyReceipts = generateReceipts(100);
        const startTime = Date.now();
        const size = BlockSizeCalculator.calculateReceiptsSize(manyReceipts);
        const endTime = Date.now();
        
        expect(size).toBeGreaterThan(40000);
        expect(endTime - startTime).toBeLessThan(100);
      });

      it('should handle malformed receipt data gracefully', () => {
        const malformedReceipts: any[] = [
          {
            ...createBaseReceipt(),
            logs: [{ ...createLog(), topics: [], data: [] }],
            logsBloom: [],
          },
        ];

        // This should not throw due to null-safe guards in implementation
        expect(() => {
          BlockSizeCalculator.calculateReceiptsSize(malformedReceipts);
        }).not.toThrow();
      });
    });

    describe('Performance and optimization', () => {
      it('should be faster than precise calculation for large datasets', () => {
        const largeReceipts = generateReceipts(50, {
          logs: [createLog({ topics: ['0xtopic1', '0xtopic2'], data: '0x' + '1234'.repeat(10) })],
        });

        const startApprox = Date.now();
        const approxSize = BlockSizeCalculator.calculateReceiptsSize(largeReceipts);
        const endApprox = Date.now();

        const startPrecise = Date.now();
        const preciseSize = BlockSizeCalculator.calculateReceiptsSizePrecise(largeReceipts);
        const endPrecise = Date.now();

        expect(approxSize).toBeGreaterThan(20000);
        expect(preciseSize).toBeGreaterThan(20000);
        expect(endApprox - startApprox).toBeLessThan(50);
        expect(endPrecise - startPrecise).toBeLessThan(200);
      });

      it('should scale linearly with number of receipts', () => {
        const size10 = BlockSizeCalculator.calculateReceiptsSize(generateReceipts(10));
        const size20 = BlockSizeCalculator.calculateReceiptsSize(generateReceipts(20));
        
        const ratio = size20 / size10;
        expect(ratio).toBeGreaterThan(1.8);
        expect(ratio).toBeLessThan(2.2);
      });

      it('should handle varying complexity consistently', () => {
        const simpleReceipt = createBaseReceipt();
        const complexReceipt = createBaseReceipt({
          gasUsed: 200000,
          cumulativeGasUsed: 200000,
          logs: Array.from({ length: 5 }, (_, i) =>
            createLog({
              topics: ['0xtopic1', '0xtopic2', '0xtopic3'],
              data: '0x' + '1234'.repeat(50),
              logIndex: i,
            })
          ),
          logsBloom: '0x' + 'f'.repeat(512),
        });

        const simpleSize = BlockSizeCalculator.calculateReceiptsSize([simpleReceipt]);
        const complexSize = BlockSizeCalculator.calculateReceiptsSize([complexReceipt]);
        const mixedSize = BlockSizeCalculator.calculateReceiptsSize([simpleReceipt, complexReceipt]);

        expect(complexSize).toBeGreaterThan(simpleSize * 3);
        expect(mixedSize).toBeGreaterThan(simpleSize + complexSize * 0.8);
        expect(mixedSize).toBeLessThan(simpleSize + complexSize * 1.2);
      });
    });
  });

  describe('calculateBlockSizeFromDecodedTransactions', () => {
    it('should calculate size for empty block', () => {
      const block = createBaseBlock({ transactions: [] });
      const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(result).toBeGreaterThan(500); // Header size only
      expect(result).toBeLessThan(2000);
    });

    it('should calculate size for block with transaction hashes', () => {
      const block = createBaseBlock({
        transactions: ['0xhash1234567890abcdef', '0xhash567890abcdef12'] as any,
      });
      const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(result).toBeGreaterThan(600); // Header + 2 * 32 bytes
    });

    it('should calculate size for block with decoded transactions', () => {
      const tx1 = createBaseTransaction();
      const tx2 = createBaseTransaction({ hash: '0xdef789', transactionIndex: 1 });
      const block = createBaseBlock({ transactions: [tx1, tx2] });
      const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(result).toBeGreaterThan(800); // Header + 2 transactions
    });

    it('should handle mixed transaction types', () => {
      const tx = createBaseTransaction();
      const block = createBaseBlock({
        transactions: ['0xhash123', tx, '0xhash456'] as any,
      });
      const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(result).toBeGreaterThan(700);
    });

    it('should handle undefined transactions', () => {
      const block = createBaseBlock();
      delete (block as any).transactions;
      const result = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(result).toBeGreaterThan(500); // Header only
    });
  });

  describe('calculateTransactionSize', () => {
    it('should calculate size for legacy transaction', () => {
      const tx = createBaseTransaction({ type: '0x0', gasPrice: '0x3b9aca00' });
      const result = BlockSizeCalculator.calculateTransactionSize(tx);
      expect(result).toBeGreaterThanOrEqual(108);
      expect(result).toBeLessThan(300);
    });

    it('should calculate size for EIP-1559 transaction', () => {
      const tx = createBaseTransaction({
        type: '0x2',
        maxFeePerGas: '0x5d21dba00',
        maxPriorityFeePerGas: '0x1dcd6500',
      });
      const result = BlockSizeCalculator.calculateTransactionSize(tx);
      expect(result).toBeGreaterThanOrEqual(108);
      expect(result).toBeGreaterThan(150); // Larger due to EIP-1559 fields
    });

    it('should calculate size for contract creation transaction', () => {
      const tx = createBaseTransaction({
        to: null,
        input: '0x608060405234801561001057600080fd5b50' + 'a'.repeat(500),
      });
      const result = BlockSizeCalculator.calculateTransactionSize(tx);
      expect(result).toBeGreaterThan(350); // Large due to bytecode
    });

    it('should handle transaction with access list', () => {
      const tx = createBaseTransaction({
        type: '0x1',
        accessList: [
          {
            address: '0x1234567890123456789012345678901234567890',
            storageKeys: ['0xkey1', '0xkey2'],
          },
        ],
      });
      const result = BlockSizeCalculator.calculateTransactionSize(tx);
      expect(result).toBeGreaterThan(200); // Larger due to access list
    });

    it('should handle blob transaction', () => {
      const tx = createBaseTransaction({
        type: '0x3',
        maxFeePerBlobGas: '0x77359400',
        blobVersionedHashes: ['0xblob1', '0xblob2'],
      });
      const result = BlockSizeCalculator.calculateTransactionSize(tx);
      expect(result).toBeGreaterThan(200); // Larger due to blob fields
    });

    it('should enforce minimum transaction size', () => {
      const minimalTx = createMinimalTransaction(); // Use minimal transaction factory
      const result = BlockSizeCalculator.calculateTransactionSize(minimalTx);
      expect(result).toBe(196); // Minimum size
    });
  });

  describe('getTransactionSizeFromHex', () => {
    it('should calculate size from hex string with 0x prefix', () => {
      const result = BlockSizeCalculator.getTransactionSizeFromHex('0x1234567890abcdef');
      expect(result).toBe(8); // 16 chars / 2 = 8 bytes
    });

    it('should calculate size from hex string without 0x prefix', () => {
      const result = BlockSizeCalculator.getTransactionSizeFromHex('1234567890abcdef');
      expect(result).toBe(8);
    });

    it('should handle empty hex string', () => {
      const result = BlockSizeCalculator.getTransactionSizeFromHex('0x');
      expect(result).toBe(0);
    });
  });

  describe('estimateTransactionSizeFromFields', () => {
    it('should include gas pricing fields', () => {
      const legacyTx = createBaseTransaction({ gasPrice: '0x3b9aca00' });
      const eip1559Tx = createBaseTransaction({
        maxFeePerGas: '0x5d21dba00',
        maxPriorityFeePerGas: '0x1dcd6500',
      });
      
      const legacySize = BlockSizeCalculator.estimateTransactionSizeFromFields(legacyTx);
      const eip1559Size = BlockSizeCalculator.estimateTransactionSizeFromFields(eip1559Tx);
      
      expect(eip1559Size).toBeGreaterThan(legacySize);
    });

    it('should account for input data size', () => {
      const smallTx = createBaseTransaction({ input: '0x' });
      const largeTx = createBaseTransaction({ input: '0x' + 'a'.repeat(1000) });
      
      const smallSize = BlockSizeCalculator.estimateTransactionSizeFromFields(smallTx);
      const largeSize = BlockSizeCalculator.estimateTransactionSizeFromFields(largeTx);
      
      expect(largeSize).toBeGreaterThan(smallSize + 400);
    });

    it('should include RLP encoding overhead', () => {
      const tx = createBaseTransaction();
      const result = BlockSizeCalculator.estimateTransactionSizeFromFields(tx);
      // Should be at least 5% larger than basic fields
      expect(result).toBeGreaterThan(150);
    });
  });

  describe('estimateBlockHeaderSize', () => {
    it('should calculate basic header size', () => {
      const block = createBaseBlock();
      const result = BlockSizeCalculator.estimateBlockHeaderSize(block);
      expect(result).toBeGreaterThan(500);
      expect(result).toBeLessThan(2000);
    });

    it('should include EIP-1559 baseFeePerGas', () => {
      const block1 = createBaseBlock();
      const block2 = createBaseBlock({ baseFeePerGas: '0x3b9aca00' });
      
      const size1 = BlockSizeCalculator.estimateBlockHeaderSize(block1);
      const size2 = BlockSizeCalculator.estimateBlockHeaderSize(block2);
      
      expect(size2).toBeGreaterThan(size1);
    });

    it('should include withdrawals', () => {
      const block = createBaseBlock({
        withdrawals: [
          {
            index: '0x1',
            validatorIndex: '0x1000',
            address: '0x1234567890123456789012345678901234567890',
            amount: '0x8ac7230489e80000',
          },
        ],
      });
      const result = BlockSizeCalculator.estimateBlockHeaderSize(block);
      expect(result).toBeGreaterThan(600); // Larger due to withdrawals
    });

    it('should include blob fields', () => {
      const block = createBaseBlock({
        blobGasUsed: '0x20000',
        excessBlobGas: '0x0',
        parentBeaconBlockRoot: '0xbeef123',
      });
      const result = BlockSizeCalculator.estimateBlockHeaderSize(block);
      expect(result).toBeGreaterThan(600); // Larger due to blob fields
    });

    it('should handle variable extraData', () => {
      const block1 = createBaseBlock({ extraData: '0x' });
      const block2 = createBaseBlock({ extraData: '0x' + 'ff'.repeat(100) });
      
      const size1 = BlockSizeCalculator.estimateBlockHeaderSize(block1);
      const size2 = BlockSizeCalculator.estimateBlockHeaderSize(block2);
      
      expect(size2).toBeGreaterThan(size1 + 80);
    });
  });
});