import { JsonRpcProvider } from '../json-rpc.provider';
import type { NetworkConfig } from '../interfaces';

describe('JsonRpcProvider Normalization', () => {
  let provider: JsonRpcProvider;
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

    provider = new JsonRpcProvider({
        uniqName: 'w',
        httpUrl: 'http://localhost:8545',
        network: mockNetworkConfig,
    });
  });

  describe('normalizeRawBlock', () => {
    it('should normalize block with hex values', () => {
      const rawBlock = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: '0x3039', // 12345
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        difficulty: '0xf4240',
        totalDifficulty: '0x4c4b40',
        extraData: '0x',
        size: '0x400', // 1024
        gasLimit: '0x1c9c380', // 30000000
        gasUsed: '0xe4e1c0', // 15000000
        timestamp: '0x61d4a400',
        uncles: [],
        baseFeePerGas: '0x4a817c800',
        blobGasUsed: '0x20000',
        excessBlobGas: '0x0',
        parentBeaconBlockRoot: '0xbeacon123',
        transactions: [],
      };

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.number).toBe(12345);
      expect(result.size).toBe(1024);
      expect(result.gasLimit).toBe(30000000);
      expect(result.gasUsed).toBe(15000000);
      expect(result.baseFeePerGas).toBe('0x4a817c800');
      expect(result.blobGasUsed).toBe('0x20000');
    });

    it('should handle blockNumber vs number fields', () => {
      const rawBlock = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        blockNumber: '0x3039',
        gasLimit: '0x1c9c380',
        gasUsed: '0xe4e1c0',
        timestamp: '0x61d4a400',
        uncles: [],
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        extraData: '0x',
        transactions: [],
      };

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.blockNumber).toBe(12345);
      expect(result.number).toBeUndefined();
    });

    it('should handle transactions as strings or objects', () => {
      const rawBlock = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: '0x3039',
        gasLimit: '0x1c9c380',
        gasUsed: '0xe4e1c0',
        timestamp: '0x61d4a400',
        uncles: [],
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        extraData: '0x',
        transactions: ['0xtx1', '0xtx2'],
      };

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.transactions).toEqual(['0xtx1', '0xtx2']);
    });
  });

  describe('normalizeRawTransaction', () => {
    it('should normalize Legacy transaction', () => {
      const rawTx = {
        hash: '0xtx123',
        nonce: '0x2a', // 42
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: '0x5208', // 21000
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '0x3039', // 12345
        transactionIndex: '0x0',
        gasPrice: '0x4a817c800',
        chainId: '0x1',
        v: '0x1b',
        r: '0xr123',
        s: '0xs456',
        type: '0x0',
      };

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.nonce).toBe(42);
      expect(result.gas).toBe(21000);
      expect(result.blockNumber).toBe(12345);
      expect(result.transactionIndex).toBe(0);
      expect(result.chainId).toBe(1);
      expect(result.type).toBe('0x0');
      expect(result.gasPrice).toBe('0x4a817c800');
    });

    it('should normalize EIP-1559 transaction', () => {
      const rawTx = {
        hash: '0xtx123',
        nonce: '0x2a',
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: '0x5208',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '0x3039',
        transactionIndex: '0x0',
        chainId: '0x1',
        maxFeePerGas: '0x6fc23ac00',
        maxPriorityFeePerGas: '0x77359400',
        v: '0x0',
        r: '0xr123',
        s: '0xs456',
        type: '0x2',
        accessList: [],
      };

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x2');
      expect(result.maxFeePerGas).toBe('0x6fc23ac00');
      expect(result.maxPriorityFeePerGas).toBe('0x77359400');
      expect(result.gasPrice).toBeUndefined();
    });

    it('should normalize Blob transaction', () => {
      const rawTx = {
        hash: '0xtx123',
        nonce: '0x2a',
        from: '0xfrom123',
        to: '0xto456',
        value: '0x0',
        gas: '0x5208',
        input: '0xblobdata',
        blockHash: '0xblock123',
        blockNumber: '0x3039',
        transactionIndex: '0x0',
        chainId: '0x1',
        maxFeePerGas: '0x6fc23ac00',
        maxPriorityFeePerGas: '0x77359400',
        maxFeePerBlobGas: '0x3b9aca00',
        blobVersionedHashes: ['0xblob1', '0xblob2'],
        v: '0x0',
        r: '0xr123',
        s: '0xs456',
        type: '0x3',
      };

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x3');
      expect(result.maxFeePerBlobGas).toBe('0x3b9aca00');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle missing fields with defaults', () => {
      const rawTx = {
        hash: '0xtx123',
        nonce: '0x2a',
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: '0x5208',
        input: '0x',
        v: '0x1b',
        r: '0xr123',
        s: '0xs456',
        // Missing type, blockNumber, etc.
      };

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x0');
      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
      expect(result.chainId).toBeUndefined();
    });
  });

  describe('normalizeRawReceipt', () => {
    it('should normalize receipt', () => {
      const rawReceipt = {
        transactionHash: '0xtx123',
        transactionIndex: '0x0',
        blockHash: '0xblock123',
        blockNumber: '0x3039',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: '0x1',
        type: '0x2',
        effectiveGasPrice: '0x5d21dba00',
        blobGasUsed: '0x20000',
        blobGasPrice: '0x3b9aca00',
      };

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.transactionIndex).toBe(0);
      expect(result.blockNumber).toBe(12345);
      expect(result.status).toBe('0x1');
      expect(result.cumulativeGasUsed).toBe(21000);
      expect(result.gasUsed).toBe(21000);
      expect(result.blobGasUsed).toBe('0x20000');
    });

    it('should handle failed transaction', () => {
      const rawReceipt = {
        transactionHash: '0xtx123',
        transactionIndex: '0x0',
        blockHash: '0xblock123',
        blockNumber: '0x3039',
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: '0x0',
        type: '0x0',
        effectiveGasPrice: '0x4a817c800',
      };

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.status).toBe('0x0');
    });
  });

  describe('normalizeRawLog', () => {
    it('should normalize log', () => {
      const rawLog = {
        address: '0xcontract123',
        topics: ['0xtopic1', '0xtopic2'],
        data: '0xlogdata',
        blockNumber: '0x3039',
        transactionHash: '0xtx123',
        transactionIndex: '0x0',
        blockHash: '0xblock123',
        logIndex: '0x5',
        removed: false,
      };

      const result = provider['normalizeRawLog'](rawLog);

      expect(result.blockNumber).toBe(12345);
      expect(result.transactionIndex).toBe(0);
      expect(result.logIndex).toBe(5);
      expect(result.removed).toBe(false);
    });

    it('should handle missing fields', () => {
      const rawLog = {
        address: '0xcontract123',
        topics: ['0xtopic1'],
        data: '0xlogdata',
        transactionHash: '0xtx123',
      };

      const result = provider['normalizeRawLog'](rawLog);

      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
      expect(result.logIndex).toBeNull();
      expect(result.removed).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should throw error for malformed hex', () => {
      const rawTx = {
        hash: '0xtx123',
        nonce: '0xGGG', // Invalid hex
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: '0x5208',
        input: '0x',
        v: '0x1b',
        r: '0xr123',
        s: '0xs456',
      };

      expect(() => {
        provider['normalizeRawTransaction'](rawTx);
      }).toThrow();
    });

    it('should handle access list', () => {
      const accessList = [
        { address: '0xcontract1', storageKeys: ['0xkey1', '0xkey2'] },
        { address: '0xcontract2', storageKeys: ['0xkey3'] },
      ];

      const rawTx = {
        hash: '0xtx123',
        nonce: '0x2a',
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: '0x5208',
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: '0x3039',
        transactionIndex: '0x0',
        chainId: '0x1',
        gasPrice: '0x4a817c800',
        type: '0x1',
        accessList,
      };

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.accessList).toEqual(accessList);
    });

    it('should handle withdrawals', () => {
      const withdrawals = [
        { index: '0x1', validatorIndex: '0x2', address: '0xvalidator1', amount: '0x3b9aca00' },
      ];

      const rawBlock = {
        hash: '0xabc123',
        parentHash: '0xdef456',
        number: '0x3039',
        gasLimit: '0x1c9c380',
        gasUsed: '0xe4e1c0',
        timestamp: '0x61d4a400',
        uncles: [],
        nonce: '0x0000000000000000',
        sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        logsBloom: '0x00000000000000000000000000000000',
        transactionsRoot: '0x789abc',
        stateRoot: '0xstate123',
        receiptsRoot: '0xreceipts456',
        miner: '0xminer789',
        extraData: '0x',
        withdrawals,
        withdrawalsRoot: '0xwithdrawalsroot123',
        transactions: [],
      };

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.withdrawals).toEqual(withdrawals);
      expect(result.withdrawalsRoot).toBe('0xwithdrawalsroot123');
    });
  });
});