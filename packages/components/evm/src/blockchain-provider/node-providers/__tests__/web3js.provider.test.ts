import { Web3jsProvider } from '../web3js.provider';
import type { NetworkConfig } from '../interfaces';

describe('Web3jsProvider Normalization', () => {
  let provider: Web3jsProvider;
  let mockNetworkConfig: NetworkConfig;

  beforeEach(() => {
    mockNetworkConfig = {
      chainId: 1,
      nativeCurrencySymbol: 'ETH',
      nativeCurrencyDecimals: 18,
      blockTime: 12,
      hasEIP1559: true,
      hasWithdrawals: true,
      hasBlobTransactions: true,
    };

    provider = new Web3jsProvider({
        uniqName: 'w',
        httpUrl: 'http://localhost:8545',
        network: mockNetworkConfig,
    });
  });

  describe('normalizeBlock', () => {
    it('should normalize web3 block with BigInt values', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: 12345n, // BigInt in v4
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        difficulty: 1000000n, // BigInt in v4
        totalDifficulty: 5000000n, // BigInt in v4
        extraData: '0x',
        size: 1024n, // BigInt in v4
        gasLimit: 30000000n, // BigInt in v4
        gasUsed: 15000000n, // BigInt in v4
        timestamp: 1640995200n, // BigInt in v4
        uncles: [],
        baseFeePerGas: 20000000000n, // BigInt in v4
        blobGasUsed: 131072n, // BigInt in v4
        excessBlobGas: 0n, // BigInt in v4
        parentBeaconBlockRoot: '0xbeacon123',
        transactions: [],
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result).toEqual({
        hash: '0xabc123',
        parentHash: '0xdef456',
        blockNumber: 12345,
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        difficulty: '1000000',
        totalDifficulty: '5000000',
        extraData: '0x',
        size: 1024,
        gasLimit: 30000000,
        gasUsed: 15000000,
        timestamp: 1640995200,
        uncles: [],
        baseFeePerGas: '20000000000',
        withdrawals: undefined,
        withdrawalsRoot: undefined,
        blobGasUsed: '131072',
        excessBlobGas: '0',
        parentBeaconBlockRoot: '0xbeacon123',
        transactions: [],
      });
    });

    it('should handle blockNumber field preference over number', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        blockNumber: 12345n, // BigInt in v4
        number: 67890n, // Should prefer blockNumber over number
        gasLimit: 30000000n,
        gasUsed: 15000000n,
        timestamp: 1640995200n,
        uncles: [],
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        extraData: '0x',
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result.blockNumber).toBe(12345);
    });

    it('should fallback to number field when blockNumber is missing', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: 67890n, // BigInt in v4
        gasLimit: 30000000n,
        gasUsed: 15000000n,
        timestamp: 1640995200n,
        uncles: [],
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        extraData: '0x',
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result.blockNumber).toBe(67890);
    });

    it('should handle missing optional fields with defaults', () => {
      const minimalBlock = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: 12345n, // BigInt in v4
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: 30000000n,
        gasUsed: 15000000n,
        timestamp: 1640995200n,
        uncles: [],
        extraData: '0x',
      };

      const result = provider['normalizeBlock'](minimalBlock);

      expect(result.difficulty).toBe('0');
      expect(result.totalDifficulty).toBe('0');
      expect(result.size).toBe(0);
      expect(result.baseFeePerGas).toBeUndefined();
      expect(result.blobGasUsed).toBeUndefined();
    });

    it('should normalize transactions in block when full objects provided', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: 12345n,
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: 30000000n,
        gasUsed: 15000000n,
        timestamp: 1640995200n,
        uncles: [],
        extraData: '0x',
        transactions: [{
          hash: '0xtx123',
          nonce: 42n, // BigInt in v4
          from: '0xfrom123',
          to: '0xto456',
          value: 1000000000000000000n, // BigInt in v4
          gas: 21000n, // BigInt in v4
          input: '0x',
          type: 2n, // BigInt in v4
        }],
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.hash).toBe('0xtx123');
      expect(result.transactions![0]!.type).toBe('2');
    });

    it('should handle transactions as hashes when not hydrated', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: 12345n,
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: 30000000n,
        gasUsed: 15000000n,
        timestamp: 1640995200n,
        uncles: [],
        extraData: '0x',
        transactions: ['0xtx123', '0xtx456'], // String hashes when not hydrated
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result.transactions).toEqual(['0xtx123', '0xtx456']);
    });
  });

  describe('normalizeTransaction', () => {
    it('should normalize Legacy transaction (type 0) with BigInt values', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: 42n, // BigInt in v4
        from: '0xfrom123',
        to: '0xto456',
        value: 1000000000000000000n, // BigInt in v4
        gas: 21000n, // BigInt in v4
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 12345n, // BigInt in v4
        transactionIndex: 0n, // BigInt in v4
        gasPrice: 20000000000n, // BigInt in v4
        chainId: 1n, // BigInt in v4
        v: 27n, // BigInt in v4
        r: '0xr123',
        s: '0xs456',
        type: 0n, // BigInt in v4
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result).toEqual({
        hash: '0xtx123',
        nonce: 42,
        from: '0xfrom123',
        to: '0xto456',
        value: '1000000000000000000',
        gas: 21000,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 12345,
        transactionIndex: 0,
        gasPrice: '20000000000',
        chainId: 1,
        v: '27',
        r: '0xr123',
        s: '0xs456',
        type: '0',
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
        accessList: undefined,
        maxFeePerBlobGas: undefined,
        blobVersionedHashes: undefined,
      });
    });

    it('should normalize EIP-1559 transaction (type 2) with BigInt values', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: 42n,
        from: '0xfrom123',
        to: '0xto456',
        value: 1000000000000000000n,
        gas: 21000n,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 12345n,
        transactionIndex: 0n,
        chainId: 1n,
        maxFeePerGas: 30000000000n, // BigInt in v4
        maxPriorityFeePerGas: 2000000000n, // BigInt in v4
        v: 0n,
        r: '0xr123',
        s: '0xs456',
        type: 2n,
        accessList: [],
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.type).toBe('2');
      expect(result.gasPrice).toBeUndefined();
      expect(result.maxFeePerGas).toBe('30000000000');
      expect(result.maxPriorityFeePerGas).toBe('2000000000');
      expect(result.accessList).toEqual([]);
    });

    it('should normalize Blob transaction (type 3) with BigInt values', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: 42n,
        from: '0xfrom123',
        to: '0xto456',
        value: 0n,
        gas: 21000n,
        input: '0xblobdata',
        blockHash: '0xblock123',
        blockNumber: 12345n,
        transactionIndex: 0n,
        chainId: 1n,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
        maxFeePerBlobGas: 1000000000n, // BigInt in v4
        blobVersionedHashes: ['0xblob1', '0xblob2'],
        v: 0n,
        r: '0xr123',
        s: '0xs456',
        type: 3n,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.type).toBe('3');
      expect(result.maxFeePerBlobGas).toBe('1000000000');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle BigInt conversion', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: 999n,
        from: '0xfrom123',
        to: '0xto456',
        value: 999999999999999999999999n, // Very large BigInt
        gas: 100000n,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 999999n,
        transactionIndex: 55n,
        gasPrice: 50000000000n,
        chainId: 137n, // Polygon
        v: 27n,
        r: '0xr123',
        s: '0xs456',
        type: 0n,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(999);
      expect(result.gas).toBe(100000);
      expect(result.blockNumber).toBe(999999);
      expect(result.transactionIndex).toBe(55);
      expect(result.chainId).toBe(137);
      expect(result.value).toBe('999999999999999999999999');
      expect(result.gasPrice).toBe('50000000000');
    });

    it('should handle missing fields with defaults', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: undefined,
        from: '0xfrom123',
        to: '0xto456',
        value: undefined,
        gas: 21000n,
        input: undefined,
        blockHash: '0xblock123',
        blockNumber: 12345n,
        transactionIndex: 0n,
        chainId: 1n,
        type: undefined,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(0);
      expect(result.value).toBe('0');
      expect(result.input).toBe('0x');
      expect(result.type).toBe('0');
    });
  });

  describe('normalizeReceipt', () => {
    it('should normalize web3 transaction receipt with BigInt values', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: 0n, // BigInt in v4
        blockHash: '0xblock123',
        blockNumber: 12345n, // BigInt in v4
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 21000n, // BigInt in v4
        gasUsed: 21000n, // BigInt in v4
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: 2n, // BigInt in v4
        effectiveGasPrice: 25000000000n, // BigInt in v4
        blobGasUsed: 131072n, // BigInt in v4
        blobGasPrice: 1000000000n, // BigInt in v4
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result).toEqual({
        transactionHash: '0xtx123',
        transactionIndex: 0,
        blockHash: '0xblock123',
        blockNumber: 12345,
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: '0x1',
        type: '2',
        effectiveGasPrice: 25000000000,
        blobGasUsed: '131072',
        blobGasPrice: '1000000000',
      });
    });

    it('should handle failed transaction status', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: 0n,
        blockHash: '0xblock123',
        blockNumber: 12345n,
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 21000n,
        gasUsed: 21000n,
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: false, // Failed transaction
        type: 0n,
        effectiveGasPrice: 20000000000n,
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.status).toBe('0x0');
    });

    it('should normalize logs in receipt with BigInt values', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: 0n,
        blockHash: '0xblock123',
        blockNumber: 12345n,
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 21000n,
        gasUsed: 21000n,
        contractAddress: null,
        logs: [
          {
            address: '0xcontract123',
            topics: ['0xtopic1', '0xtopic2'],
            data: '0xlogdata',
            blockNumber: 12345n, // BigInt in v4
            transactionHash: '0xtx123',
            transactionIndex: 0n, // BigInt in v4
            blockHash: '0xblock123',
            logIndex: 0n, // BigInt in v4
            removed: false,
          },
        ],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: 2n,
        effectiveGasPrice: 25000000000n,
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).toEqual({
        address: '0xcontract123',
        topics: ['0xtopic1', '0xtopic2'],
        data: '0xlogdata',
        blockNumber: 12345,
        transactionHash: '0xtx123',
        transactionIndex: 0,
        blockHash: '0xblock123',
        logIndex: 0,
        removed: false,
      });
    });

    it('should handle large BigInt gas values', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: 0n,
        blockHash: '0xblock123',
        blockNumber: 12345n,
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 999999999n, // Large BigInt
        gasUsed: 500000000n, // Large BigInt
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: 2n,
        effectiveGasPrice: 100000000000n, // 100 gwei as BigInt
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.cumulativeGasUsed).toBe(999999999);
      expect(result.gasUsed).toBe(500000000);
      expect(result.effectiveGasPrice).toBe(100000000000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle access list normalization', () => {
      const accessList = [
        {
          address: '0xcontract1',
          storageKeys: ['0xkey1', '0xkey2'],
        },
        {
          address: '0xcontract2',
          storageKeys: ['0xkey3'],
        },
      ];

      const web3Tx = {
        hash: '0xtx123',
        nonce: 42n,
        from: '0xfrom123',
        to: '0xto456',
        value: 1000000000000000000n,
        gas: 21000n,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 12345n,
        transactionIndex: 0n,
        chainId: 1n,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
        type: 1n,
        accessList,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.accessList).toEqual(accessList);
    });

    it('should handle withdrawals in block', () => {
      const withdrawals = [
        {
          index: '0x1',
          validatorIndex: '0x2',
          address: '0xvalidator1',
          amount: '0x3b9aca00',
        },
      ];

      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: 12345n,
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: 30000000n,
        gasUsed: 15000000n,
        timestamp: 1640995200n,
        uncles: [],
        extraData: '0x',
        withdrawals,
        withdrawalsRoot: '0xwithdrawalsroot123',
        transactions: [],
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result.withdrawals).toEqual(withdrawals);
      expect(result.withdrawalsRoot).toBe('0xwithdrawalsroot123');
    });

    it('should handle zero BigInt values correctly', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: 0n,
        from: '0xfrom123',
        to: '0xto456',
        value: 0n,
        gas: 21000n,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 0n,
        transactionIndex: 0n,
        gasPrice: 0n,
        chainId: 0n,
        type: 0n,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(0);
      expect(result.value).toBe('0');
      expect(result.blockNumber).toBe(0);
      expect(result.transactionIndex).toBe(0);
      expect(result.gasPrice).toBe('0');
      expect(result.chainId).toBe(0);
    });

    it('should handle missing blob gas fields gracefully', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: 0n,
        blockHash: '0xblock123',
        blockNumber: 12345n,
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 21000n,
        gasUsed: 21000n,
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: 0n,
        effectiveGasPrice: 20000000000n,
        // Missing blobGasUsed and blobGasPrice
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });

    it('should handle null and undefined values with BigInt fallbacks', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: null,
        from: '0xfrom123',
        to: null,
        value: null,
        gas: 21000n,
        input: null,
        blockHash: '0xblock123',
        blockNumber: 12345n,
        transactionIndex: 0n,
        gasPrice: null,
        chainId: 1n,
        v: null,
        r: null,
        s: null,
        type: null,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(0);
      expect(result.to).toBeNull();
      expect(result.value).toBe('0');
      expect(result.input).toBe('0x');
      expect(result.type).toBe('0');
    });

    it('should handle very large BigInt numbers', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: 99999999999999999999n, // Very large BigInt
        from: '0xfrom123',
        to: '0xto456',
        value: 123456789012345678901234567890n, // Extremely large BigInt
        gas: 99999999n,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 99999999999n,
        transactionIndex: 99999n,
        gasPrice: 999999999999999999999n, // Very large BigInt
        chainId: 999999n,
        type: 0n,
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(typeof result.nonce).toBe('number');
      expect(typeof result.gas).toBe('number');
      expect(typeof result.blockNumber).toBe('number');
      expect(typeof result.transactionIndex).toBe('number');
      expect(typeof result.chainId).toBe('number');
      expect(result.value).toBe('123456789012345678901234567890');
      expect(result.gasPrice).toBe('999999999999999999999');
    });
  });
});