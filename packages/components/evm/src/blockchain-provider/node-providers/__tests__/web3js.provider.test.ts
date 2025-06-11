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
    it('should normalize web3 block with string numbers', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: '12345',
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
        size: '1024',
        gasLimit: '30000000',
        gasUsed: '15000000',
        timestamp: '1640995200',
        uncles: [],
        baseFeePerGas: '20000000000',
        blobGasUsed: '131072',
        excessBlobGas: '0',
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
        blockNumber: '12345',
        number: '67890', // Should prefer blockNumber over number
        gasLimit: '30000000',
        gasUsed: '15000000',
        timestamp: '1640995200',
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
        number: '67890',
        gasLimit: '30000000',
        gasUsed: '15000000',
        timestamp: '1640995200',
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
        number: '12345',
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: '30000000',
        gasUsed: '15000000',
        timestamp: '1640995200',
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

    it('should normalize transactions in block', () => {
      const web3Block = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: '12345',
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: '30000000',
        gasUsed: '15000000',
        timestamp: '1640995200',
        uncles: [],
        extraData: '0x',
        transactions: [{
          hash: '0xtx123',
          nonce: '42',
          from: '0xfrom123',
          to: '0xto456',
          value: '1000000000000000000',
          gas: '21000',
          input: '0x',
          type: '2',
        }],
      };

      const result = provider['normalizeBlock'](web3Block);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.hash).toBe('0xtx123');
      expect(result.transactions![0]!.type).toBe('2');
    });
  });

  describe('normalizeTransaction', () => {
    it('should normalize Legacy transaction (type 0)', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: '42',
        from: '0xfrom123',
        to: '0xto456',
        value: '1000000000000000000',
        gas: '21000',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '12345',
        transactionIndex: '0',
        gasPrice: '20000000000',
        chainId: '1',
        v: '27',
        r: '0xr123',
        s: '0xs456',
        type: '0',
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

    it('should normalize EIP-1559 transaction (type 2)', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: '42',
        from: '0xfrom123',
        to: '0xto456',
        value: '1000000000000000000',
        gas: '21000',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '12345',
        transactionIndex: '0',
        chainId: '1',
        maxFeePerGas: '30000000000',
        maxPriorityFeePerGas: '2000000000',
        v: '0',
        r: '0xr123',
        s: '0xs456',
        type: '2',
        accessList: [],
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.type).toBe('2');
      expect(result.gasPrice).toBeUndefined();
      expect(result.maxFeePerGas).toBe('30000000000');
      expect(result.maxPriorityFeePerGas).toBe('2000000000');
      expect(result.accessList).toEqual([]);
    });

    it('should normalize Blob transaction (type 3)', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: '42',
        from: '0xfrom123',
        to: '0xto456',
        value: '0',
        gas: '21000',
        input: '0xblobdata',
        blockHash: '0xblock123',
        blockNumber: '12345',
        transactionIndex: '0',
        chainId: '1',
        maxFeePerGas: '30000000000',
        maxPriorityFeePerGas: '2000000000',
        maxFeePerBlobGas: '1000000000',
        blobVersionedHashes: ['0xblob1', '0xblob2'],
        v: '0',
        r: '0xr123',
        s: '0xs456',
        type: '3',
      };

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.type).toBe('3');
      expect(result.maxFeePerBlobGas).toBe('1000000000');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle numeric string conversion', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: '999',
        from: '0xfrom123',
        to: '0xto456',
        value: '999999999999999999999999',
        gas: '100000',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '999999',
        transactionIndex: '55',
        gasPrice: '50000000000',
        chainId: '137', // Polygon
        v: '27',
        r: '0xr123',
        s: '0xs456',
        type: '0',
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
        gas: '21000',
        input: undefined,
        blockHash: '0xblock123',
        blockNumber: '12345',
        transactionIndex: '0',
        chainId: '1',
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
    it('should normalize web3 transaction receipt with string numbers', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: '0',
        blockHash: '0xblock123',
        blockNumber: '12345',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '21000',
        gasUsed: '21000',
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: '2',
        effectiveGasPrice: '25000000000',
        blobGasUsed: '131072',
        blobGasPrice: '1000000000',
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
        transactionIndex: '0',
        blockHash: '0xblock123',
        blockNumber: '12345',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '21000',
        gasUsed: '21000',
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: false,
        type: '0',
        effectiveGasPrice: '20000000000',
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.status).toBe('0x0');
    });

    it('should normalize logs in receipt', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: '0',
        blockHash: '0xblock123',
        blockNumber: '12345',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '21000',
        gasUsed: '21000',
        contractAddress: null,
        logs: [
          {
            address: '0xcontract123',
            topics: ['0xtopic1', '0xtopic2'],
            data: '0xlogdata',
            blockNumber: '12345',
            transactionHash: '0xtx123',
            transactionIndex: '0',
            blockHash: '0xblock123',
            logIndex: '0',
            removed: false,
          },
        ],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: '2',
        effectiveGasPrice: '25000000000',
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

    it('should handle large gas values', () => {
      const web3Receipt = {
        transactionHash: '0xtx123',
        transactionIndex: '0',
        blockHash: '0xblock123',
        blockNumber: '12345',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '999999999',
        gasUsed: '500000000',
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: '2',
        effectiveGasPrice: '100000000000', // 100 gwei
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
        nonce: '42',
        from: '0xfrom123',
        to: '0xto456',
        value: '1000000000000000000',
        gas: '21000',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '12345',
        transactionIndex: '0',
        chainId: '1',
        maxFeePerGas: '30000000000',
        maxPriorityFeePerGas: '2000000000',
        type: '1',
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
        number: '12345',
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        gasLimit: '30000000',
        gasUsed: '15000000',
        timestamp: '1640995200',
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

    it('should handle zero values correctly', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: '0',
        from: '0xfrom123',
        to: '0xto456',
        value: '0',
        gas: '21000',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '0',
        transactionIndex: '0',
        gasPrice: '0',
        chainId: '0',
        type: '0',
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
        transactionIndex: '0',
        blockHash: '0xblock123',
        blockNumber: '12345',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '21000',
        gasUsed: '21000',
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: true,
        type: '0',
        effectiveGasPrice: '20000000000',
        // Missing blobGasUsed and blobGasPrice
      };

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });

    it('should handle null and undefined values', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: null,
        from: '0xfrom123',
        to: null,
        value: null,
        gas: '21000',
        input: null,
        blockHash: '0xblock123',
        blockNumber: '12345',
        transactionIndex: '0',
        gasPrice: null,
        chainId: '1',
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

    it('should handle very large string numbers', () => {
      const web3Tx = {
        hash: '0xtx123',
        nonce: '99999999999999999999',
        from: '0xfrom123',
        to: '0xto456',
        value: '123456789012345678901234567890',
        gas: '99999999',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '99999999999',
        transactionIndex: '99999',
        gasPrice: '999999999999999999999',
        chainId: '999999',
        type: '0',
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