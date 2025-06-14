import type { 
  UniversalBlock, 
  UniversalTransaction, 
  UniversalTransactionReceipt, 
  UniversalLog,
  NetworkConfig 
} from '../node-providers';
import { BlockchainNormalizer } from '../normalizer';

describe('BlockchainNormalizer', () => {
  let normalizer: BlockchainNormalizer;
  let networkConfig: NetworkConfig;

  // Network configurations for different chains
  const ethereumConfig: NetworkConfig = {
    chainId: 1,
    nativeCurrencySymbol: 'ETH',
    nativeCurrencyDecimals: 18,
    blockTime: 12,
    hasEIP1559: true,
    hasWithdrawals: true,
    hasBlobTransactions: true,
  };

  const bscConfig: NetworkConfig = {
    chainId: 56,
    nativeCurrencySymbol: 'BNB',
    nativeCurrencyDecimals: 18,
    blockTime: 3,
    hasEIP1559: false,
    hasWithdrawals: false,
    hasBlobTransactions: false,
  };

  const polygonConfig: NetworkConfig = {
    chainId: 137,
    nativeCurrencySymbol: 'MATIC',
    nativeCurrencyDecimals: 18,
    blockTime: 2,
    hasEIP1559: true,
    hasWithdrawals: false,
    hasBlobTransactions: false,
  };

  const baseUniversalBlock: UniversalBlock = {
    hash: '0x1234567890abcdef',
    parentHash: '0xabcdef1234567890',
    blockNumber: 1000,
    nonce: '0x0000000000000042',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    miner: '0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c',
    difficulty: '0x4ea3f27bc',
    totalDifficulty: '0x10b260b6f5',
    extraData: '0x476574682f4c5649562f76312e302e302f6c696e75782f676f312e342e32',
    size: 1000,
    gasLimit: 8000000,
    gasUsed: 5000000,
    timestamp: 1634567890,
    uncles: [],
  };

  beforeEach(() => {
    networkConfig = ethereumConfig;
    normalizer = new BlockchainNormalizer(networkConfig);
  });

  describe('normalizeBlock', () => {
    it('should normalize basic block fields correctly', () => {
      const result = normalizer.normalizeBlock(baseUniversalBlock);

      expect(result).toMatchObject({
        hash: '0x1234567890abcdef',
        parentHash: '0xabcdef1234567890',
        blockNumber: 1000,
        nonce: '0x0000000000000042',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: expect.any(String),
        transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
        receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        miner: '0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c',
        difficulty: '0x4ea3f27bc',
        totalDifficulty: '0x10b260b6f5',
        extraData: '0x476574682f4c5649562f76312e302e302f6c696e75782f676f312e342e32',
        size: 1000,
        gasLimit: 8000000,
        gasUsed: 5000000,
        timestamp: 1634567890,
        uncles: [],
      });
    });

    describe('EIP-1559 support (Ethereum, Polygon)', () => {
      it('should include baseFeePerGas for networks with EIP-1559 support', () => {
        const blockWithBaseFee = {
          ...baseUniversalBlock,
          baseFeePerGas: '0x3b9aca00', // 1 Gwei
        };

        const result = normalizer.normalizeBlock(blockWithBaseFee);
        expect(result.baseFeePerGas).toBe('0x3b9aca00');
      });

      it('should not include baseFeePerGas for BSC (no EIP-1559)', () => {
        const bscNormalizer = new BlockchainNormalizer(bscConfig);
        const blockWithBaseFee = {
          ...baseUniversalBlock,
          baseFeePerGas: '0x3b9aca00',
        };

        const result = bscNormalizer.normalizeBlock(blockWithBaseFee);
        expect(result.baseFeePerGas).toBeUndefined();
      });
    });

    describe('Withdrawals support (Ethereum only)', () => {
      it('should include withdrawals for Ethereum', () => {
        const blockWithWithdrawals = {
          ...baseUniversalBlock,
          withdrawals: [
            {
              index: '0x1',
              validatorIndex: '0x2',
              address: '0x1234567890123456789012345678901234567890',
              amount: '0x100',
            },
          ],
          withdrawalsRoot: '0xabcdef',
        };

        const result = normalizer.normalizeBlock(blockWithWithdrawals);
        expect(result.withdrawals).toHaveLength(1);
        expect(result.withdrawals![0]).toEqual({
          index: '0x1',
          validatorIndex: '0x2',
          address: '0x1234567890123456789012345678901234567890',
          amount: '0x100',
        });
        expect(result.withdrawalsRoot).toBe('0xabcdef');
      });

      it('should not include withdrawals for BSC/Polygon', () => {
        const bscNormalizer = new BlockchainNormalizer(bscConfig);
        const blockWithWithdrawals = {
          ...baseUniversalBlock,
          withdrawals: [
            {
              index: '0x1',
              validatorIndex: '0x2',
              address: '0x1234567890123456789012345678901234567890',
              amount: '0x100',
            },
          ],
        };

        const result = bscNormalizer.normalizeBlock(blockWithWithdrawals);
        expect(result.withdrawals).toBeUndefined();
      });
    });

    describe('Blob transactions support (Ethereum only)', () => {
      it('should include blob fields for Ethereum', () => {
        const blockWithBlobs = {
          ...baseUniversalBlock,
          blobGasUsed: '0x20000',
          excessBlobGas: '0x0',
          parentBeaconBlockRoot: '0xbeef',
        };

        const result = normalizer.normalizeBlock(blockWithBlobs);
        expect(result.blobGasUsed).toBe('0x20000');
        expect(result.excessBlobGas).toBe('0x0');
        expect(result.parentBeaconBlockRoot).toBe('0xbeef');
      });

      it('should not include blob fields for BSC/Polygon', () => {
        const polygonNormalizer = new BlockchainNormalizer(polygonConfig);
        const blockWithBlobs = {
          ...baseUniversalBlock,
          blobGasUsed: '0x20000',
          excessBlobGas: '0x0',
          parentBeaconBlockRoot: '0xbeef',
        };

        const result = polygonNormalizer.normalizeBlock(blockWithBlobs);
        expect(result.blobGasUsed).toBeUndefined();
        expect(result.excessBlobGas).toBeUndefined();
        expect(result.parentBeaconBlockRoot).toBeUndefined();
      });
    });

    it('should normalize transactions when present', () => {
      const mockTx: UniversalTransaction = {
        hash: '0xabc123',
        nonce: 1,
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        value: '0x100',
        gas: 21000,
        input: '0x',
        gasPrice: '0x3b9aca00',
        chainId: 1,
        v: '0x1c',
        r: '0xabc',
        s: '0xdef',
      };

      const blockWithTx = {
        ...baseUniversalBlock,
        transactions: [mockTx],
      };

      const result = normalizer.normalizeBlock(blockWithTx);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.hash).toBe('0xabc123');
    });
  });

  describe('normalizeTransaction', () => {
    const baseUniversalTx: UniversalTransaction = {
      hash: '0xabc123def456',
      nonce: 42,
      from: '0x1234567890123456789012345678901234567890',
      to: '0x0987654321098765432109876543210987654321',
      value: '0x16345785d8a0000', // 0.1 ETH
      gas: 21000,
      input: '0x',
      blockHash: '0xblock123',
      blockNumber: 1000,
      transactionIndex: 5,
      v: '0x1c',
      r: '0xr123',
      s: '0xs456',
    };

    it('should normalize basic transaction fields', () => {
      const result = normalizer.normalizeTransaction(baseUniversalTx);

      expect(result).toMatchObject({
        hash: '0xabc123def456',
        blockHash: '0xblock123',
        blockNumber: 1000,
        transactionIndex: 5,
        nonce: 42,
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        value: '0x16345785d8a0000',
        gas: 21000,
        input: '0x',
        type: '0x0', // Default type
        chainId: 1, // From network config
        v: '0x1c',
        r: '0xr123',
        s: '0xs456',
      });
    });

    it('should use default values for missing optional fields', () => {
      const minimalTx = {
        hash: '0xabc123',
        nonce: 1,
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        value: '0x100',
        gas: 21000,
        input: '0x',
      };

      const result = normalizer.normalizeTransaction(minimalTx);
      expect(result.blockHash).toBe('');
      expect(result.blockNumber).toBe(0);
      expect(result.transactionIndex).toBe(0);
      expect(result.type).toBe('0x0');
      expect(result.chainId).toBe(1);
      expect(result.v).toBe('');
      expect(result.r).toBe('');
      expect(result.s).toBe('');
    });

    describe('Gas field preservation', () => {
      it('should preserve gasPrice when present', () => {
        const legacyTx = {
          ...baseUniversalTx,
          type: '0x0',
          gasPrice: '0x3b9aca00', // 1 Gwei
        };

        const result = normalizer.normalizeTransaction(legacyTx);
        expect(result.gasPrice).toBe('0x3b9aca00');
      });

      it('should preserve EIP-1559 fields when present', () => {
        const eip1559Tx = {
          ...baseUniversalTx,
          type: '0x2',
          maxFeePerGas: '0x5d21dba00', // 25 Gwei
          maxPriorityFeePerGas: '0x1dcd6500', // 0.5 Gwei
        };

        const result = normalizer.normalizeTransaction(eip1559Tx);
        expect(result.maxFeePerGas).toBe('0x5d21dba00');
        expect(result.maxPriorityFeePerGas).toBe('0x1dcd6500');
      });

      it('should preserve all gas fields when present together', () => {
        const mixedTx = {
          ...baseUniversalTx,
          type: '0x2',
          gasPrice: '0x3b9aca00',
          maxFeePerGas: '0x5d21dba00',
          maxPriorityFeePerGas: '0x1dcd6500',
        };

        const result = normalizer.normalizeTransaction(mixedTx);
        expect(result.gasPrice).toBe('0x3b9aca00');
        expect(result.maxFeePerGas).toBe('0x5d21dba00');
        expect(result.maxPriorityFeePerGas).toBe('0x1dcd6500');
      });

      it('should preserve EIP-1559 fields regardless of network config', () => {
        const bscNormalizer = new BlockchainNormalizer(bscConfig);
        const eip1559TxOnBsc = {
          ...baseUniversalTx,
          type: '0x2',
          gasPrice: '0x3b9aca00',
          maxFeePerGas: '0x5d21dba00',
          maxPriorityFeePerGas: '0x1dcd6500',
        };

        const result = bscNormalizer.normalizeTransaction(eip1559TxOnBsc);
        expect(result.gasPrice).toBe('0x3b9aca00');
        expect(result.maxFeePerGas).toBe('0x5d21dba00');
        expect(result.maxPriorityFeePerGas).toBe('0x1dcd6500');
      });
    });

    describe('Access list transactions', () => {
      it('should handle access list', () => {
        const accessListTx = {
          ...baseUniversalTx,
          type: '0x1',
          gasPrice: '0x3b9aca00',
          accessList: [
            {
              address: '0x1234567890123456789012345678901234567890',
              storageKeys: ['0xkey1', '0xkey2'],
            },
          ],
        };

        const result = normalizer.normalizeTransaction(accessListTx);
        expect(result.accessList).toHaveLength(1);
        expect(result.accessList![0]).toEqual({
          address: '0x1234567890123456789012345678901234567890',
          storageKeys: ['0xkey1', '0xkey2'],
        });
      });
    });

    describe('Blob transactions', () => {
      it('should preserve blob fields when present', () => {
        const blobTx = {
          ...baseUniversalTx,
          type: '0x3',
          maxFeePerGas: '0x5d21dba00',
          maxPriorityFeePerGas: '0x1dcd6500',
          maxFeePerBlobGas: '0x77359400', // 2 Gwei
          blobVersionedHashes: ['0xhash1', '0xhash2'],
        };

        const result = normalizer.normalizeTransaction(blobTx);
        expect(result.maxFeePerBlobGas).toBe('0x77359400');
        expect(result.blobVersionedHashes).toEqual(['0xhash1', '0xhash2']);
      });

      it('should preserve blob fields regardless of network config', () => {
        const polygonNormalizer = new BlockchainNormalizer(polygonConfig);
        const blobTx = {
          ...baseUniversalTx,
          type: '0x3',
          maxFeePerBlobGas: '0x77359400',
          blobVersionedHashes: ['0xhash1', '0xhash2'],
        };

        const result = polygonNormalizer.normalizeTransaction(blobTx);
        expect(result.maxFeePerBlobGas).toBe('0x77359400');
        expect(result.blobVersionedHashes).toEqual(['0xhash1', '0xhash2']);
      });
    });
  });

  describe('normalizeTransactionReceipt', () => {
    const baseMockLog: UniversalLog = {
      address: '0x1234567890123456789012345678901234567890',
      topics: ['0xtopic1', '0xtopic2'],
      data: '0xdata123',
      blockNumber: 1000,
      transactionHash: '0xtxhash',
      transactionIndex: 5,
      blockHash: '0xblockhash',
      logIndex: 2,
      removed: false,
    };

    const baseUniversalReceipt: UniversalTransactionReceipt = {
      transactionHash: '0xabc123def456',
      transactionIndex: 5,
      blockHash: '0xblock123',
      blockNumber: 1000,
      from: '0x1234567890123456789012345678901234567890',
      to: '0x0987654321098765432109876543210987654321',
      cumulativeGasUsed: 100000,
      gasUsed: 21000,
      contractAddress: null,
      logs: [baseMockLog],
      logsBloom: '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      status: '0x1',
    };

    it('should normalize basic receipt fields', () => {
      const result = normalizer.normalizeTransactionReceipt(baseUniversalReceipt);

      expect(result).toMatchObject({
        transactionHash: '0xabc123def456',
        transactionIndex: 5,
        blockHash: '0xblock123',
        blockNumber: 1000,
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        cumulativeGasUsed: 100000,
        gasUsed: 21000,
        contractAddress: null,
        logs: expect.any(Array),
        logsBloom: expect.any(String),
        status: '0x1',
        type: '0x0', // Default type
        effectiveGasPrice: 0, // Default value
      });
    });

    it('should normalize logs correctly', () => {
      const result = normalizer.normalizeTransactionReceipt(baseUniversalReceipt);
      
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).toEqual({
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0xtopic1', '0xtopic2'],
        data: '0xdata123',
        blockNumber: 1000,
        transactionHash: '0xtxhash',
        transactionIndex: 5,
        blockHash: '0xblockhash',
        logIndex: 2,
        removed: false,
      });
    });

    it('should handle blob transaction receipts on Ethereum', () => {
      const blobReceipt = {
        ...baseUniversalReceipt,
        blobGasUsed: '0x20000',
        blobGasPrice: '0x77359400',
      };

      const result = normalizer.normalizeTransactionReceipt(blobReceipt);
      expect(result.blobGasUsed).toBe('0x20000');
      expect(result.blobGasPrice).toBe('0x77359400');
    });

    it('should not include blob fields for non-supporting networks', () => {
      const bscNormalizer = new BlockchainNormalizer(bscConfig);
      const blobReceipt = {
        ...baseUniversalReceipt,
        blobGasUsed: '0x20000',
        blobGasPrice: '0x77359400',
      };

      const result = bscNormalizer.normalizeTransactionReceipt(blobReceipt);
      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });

    it('should handle contract creation receipts', () => {
      const contractCreationReceipt = {
        ...baseUniversalReceipt,
        to: null,
        contractAddress: '0xnewcontract123456789012345678901234567890',
      };

      const result = normalizer.normalizeTransactionReceipt(contractCreationReceipt);
      expect(result.to).toBeNull();
      expect(result.contractAddress).toBe('0xnewcontract123456789012345678901234567890');
    });
  });

  describe('normalizeLog', () => {
    it('should normalize log with all fields present', () => {
      const universalLog: UniversalLog = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0xtopic1', '0xtopic2', '0xtopic3'],
        data: '0xdata123456789abcdef',
        blockNumber: 1000,
        transactionHash: '0xtxhash123',
        transactionIndex: 5,
        blockHash: '0xblockhash123',
        logIndex: 2,
        removed: false,
      };

      const result = normalizer.normalizeLog(universalLog);
      expect(result).toEqual(universalLog);
    });

    it('should use default values for missing optional fields', () => {
      const minimalLog: UniversalLog = {
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0xtopic1'],
        data: '0xdata123',
      };

      const result = normalizer.normalizeLog(minimalLog);
      expect(result).toEqual({
        address: '0x1234567890123456789012345678901234567890',
        topics: ['0xtopic1'],
        data: '0xdata123',
        blockNumber: 0,
        transactionHash: '',
        transactionIndex: 0,
        blockHash: '',
        logIndex: 0,
        removed: false,
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should handle complete Ethereum transaction flow', () => {
      // Modern Ethereum block with EIP-1559 transaction
      const ethereumBlock = {
        hash: '0xblock123',
        parentHash: '0xparent456',
        blockNumber: 18000000,
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00',
        transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        stateRoot: '0xstate',
        receiptsRoot: '0xreceipts',
        miner: '0x0000000000000000000000000000000000000000',
        difficulty: '0x0',
        totalDifficulty: '0x58750003716598352816469',
        extraData: '0x',
        size: 2000,
        gasLimit: 30000000,
        gasUsed: 15000000,
        timestamp: 1700000000,
        uncles: [],
        baseFeePerGas: '0x2540be400',
        transactions: [
          {
            hash: '0xtx123',
            nonce: 42,
            from: '0x1234567890123456789012345678901234567890',
            to: '0x0987654321098765432109876543210987654321',
            value: '0x16345785d8a0000',
            gas: 21000,
            input: '0x',
            blockHash: '0xblock123',
            blockNumber: 18000000,
            transactionIndex: 0,
            type: '0x2',
            maxFeePerGas: '0x2540be400',
            maxPriorityFeePerGas: '0x3b9aca00',
            chainId: 1,
            v: '0x0',
            r: '0xr123',
            s: '0xs456',
          },
        ],
      };

      const result = normalizer.normalizeBlock(ethereumBlock);
      
      expect(result.blockNumber).toBe(18000000);
      expect(result.baseFeePerGas).toBe('0x2540be400');
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.type).toBe('0x2');
      expect(result.transactions![0]!.maxFeePerGas).toBe('0x2540be400');
    });

    it('should handle BSC transaction with preserved gas fields', () => {
      const bscTransaction = {
        hash: '0xbsc123',
        nonce: 1,
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        value: '0x16345785d8a0000',
        gas: 5000000, // High gas for DeFi transaction
        input: '0xa9059cbb...', // ERC-20 transfer
        blockHash: '0xbscblock',
        blockNumber: 30000000,
        transactionIndex: 5,
        gasPrice: '0x12a05f200', // 5 Gwei
        chainId: 56,
        v: '0x93',
        r: '0xr123',
        s: '0xs456',
        type: '0x0', // Legacy transaction
      };

      const bscNormalizer = new BlockchainNormalizer(bscConfig);
      const result = bscNormalizer.normalizeTransaction(bscTransaction);
      
      expect(result.gas).toBe(5000000);
      expect(result.gasPrice).toBe('0x12a05f200');
      expect(result.chainId).toBe(56);
      expect(result.type).toBe('0x0');
    });

    it('should handle Polygon EIP-1559 transaction with access list', () => {
      const polygonTransaction = {
        hash: '0xpoly123',
        nonce: 10,
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
        value: '0x16345785d8a0000',
        gas: 100000,
        input: '0xa9059cbb...',
        blockHash: '0xpolyblock',
        blockNumber: 45000000,
        transactionIndex: 2,
        type: '0x2',
        maxFeePerGas: '0x77359400', // 2 Gwei
        maxPriorityFeePerGas: '0x3b9aca00', // 1 Gwei
        accessList: [
          {
            address: '0x1234567890123456789012345678901234567890',
            storageKeys: ['0xkey1', '0xkey2'],
          },
        ],
        chainId: 137,
        v: '0x0',
        r: '0xr123',
        s: '0xs456',
      };

      const polygonNormalizer = new BlockchainNormalizer(polygonConfig);
      const result = polygonNormalizer.normalizeTransaction(polygonTransaction);
      
      expect(result.maxFeePerGas).toBe('0x77359400');
      expect(result.maxPriorityFeePerGas).toBe('0x3b9aca00');
      expect(result.accessList).toHaveLength(1);
      expect(result.chainId).toBe(137);
    });
  });

  describe('sizeWithoutReceipts field', () => {
    it('should calculate sizeWithoutReceipts when size and receipts are provided', () => {
    const blockWithReceipts = {
      ...baseUniversalBlock,
      size: 5000,
      receipts: [
        {
          transactionHash: '0x111',
          transactionIndex: 0,
          blockHash: '0x123',
          blockNumber: 1000,
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          cumulativeGasUsed: 21000,
          gasUsed: 21000,
          contractAddress: null,
          logs: [
            {
              address: '0x1234567890123456789012345678901234567890',
              topics: ['0xtopic1'],
              data: '0x1234',
              blockNumber: 1000,
              transactionHash: '0x111',
              transactionIndex: 0,
              blockHash: '0x123',
              logIndex: 0,
              removed: false,
            },
          ],
          logsBloom: '0x' + '0'.repeat(512),
          status: '0x1',
        },
      ],
    } as UniversalBlock;;

    const result = normalizer.normalizeBlock(blockWithReceipts);
    
    expect(result.size).toBe(5736);
    expect(result.sizeWithoutReceipts).toBeDefined();
    expect(result.sizeWithoutReceipts).toBeLessThan(5001);
    expect(result.sizeWithoutReceipts).toBeGreaterThan(0);
  });

    it('should set sizeWithoutReceipts equal to size when no receipts present', () => {
      const blockWithoutReceipts = {
        ...baseUniversalBlock,
        size: 1500,
        receipts: undefined,
      };

      const result = normalizer.normalizeBlock(blockWithoutReceipts);
      
      expect(result.size).toBe(1500);
      expect(result.sizeWithoutReceipts).toBe(1500);
    });

    it('should handle empty receipts array', () => {
      const blockWithEmptyReceipts = {
        ...baseUniversalBlock,
        size: 1000,
        receipts: [],
      };

      const result = normalizer.normalizeBlock(blockWithEmptyReceipts);
      
      expect(result.size).toBe(1000);
      expect(result.sizeWithoutReceipts).toBe(1000);
    });

    it('should calculate both size and sizeWithoutReceipts when size not provided', () => {
      const blockWithoutSize = {
        ...baseUniversalBlock,
        transactions: [
          {
            hash: '0xtx1',
            nonce: 1,
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222',
            value: '0x100',
            gas: 21000,
            input: '0x',
            gasPrice: '0x3b9aca00',
            chainId: 1,
            v: '0x1c',
            r: '0xabc',
            s: '0xdef',
          },
        ],
        receipts: [
          {
            transactionHash: '0xtx1',
            transactionIndex: 0,
            blockHash: '0x123',
            blockNumber: 1000,
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222',
            cumulativeGasUsed: 21000,
            gasUsed: 21000,
            contractAddress: null,
            logs: [],
            logsBloom: '0x' + '0'.repeat(512),
            status: '0x1',
          },
        ],
      } as UniversalBlock;

      const result = normalizer.normalizeBlock(blockWithoutSize);
      
      expect(result.size).toBeDefined();
      expect(result.sizeWithoutReceipts).toBeDefined();
      expect(result.sizeWithoutReceipts).toBeLessThan(result.size!);
      expect(result.sizeWithoutReceipts).toBeGreaterThan(0);
    });

    it('should calculate sizeWithoutReceipts with complex receipts correctly', () => {
      const blockWithComplexReceipts = {
        ...baseUniversalBlock,
        size: 10000,
        receipts: [
          {
            transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
            transactionIndex: 0,
            blockHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
            blockNumber: 1000,
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222',
            cumulativeGasUsed: 150000,
            gasUsed: 150000,
            contractAddress: null,
            logs: [
              {
                address: '0x1111111111111111111111111111111111111111',
                topics: [
                  '0xtopic1111111111111111111111111111111111111111111111111111111111',
                  '0xtopic2222222222222222222222222222222222222222222222222222222222',
                  '0xtopic3333333333333333333333333333333333333333333333333333333333',
                ],
                data: '0x' + '1234'.repeat(100), // Large data
                blockNumber: 1000,
                transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
                transactionIndex: 0,
                blockHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
                logIndex: 0,
                removed: false,
              },
            ],
            logsBloom: '0x' + 'a'.repeat(512),
            status: '0x1',
          },
        ],
      } as UniversalBlock;;

      const result = normalizer.normalizeBlock(blockWithComplexReceipts);
      
      expect(result.size).toBe(11120);
      expect(result.sizeWithoutReceipts).toBeDefined();
      expect(result.sizeWithoutReceipts).toBeLessThan(10001);
      expect(result.sizeWithoutReceipts).toBeGreaterThan(0);
      
      // The difference should be significant due to complex receipts
      const receiptSize = result.size! - result.sizeWithoutReceipts!;
      expect(receiptSize).toBeGreaterThan(500); // Should be substantial
    });
  });
});