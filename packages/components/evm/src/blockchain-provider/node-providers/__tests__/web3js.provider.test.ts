import { Web3jsProvider } from '../web3js.provider';
import type { NetworkConfig } from '../interfaces';

describe('Web3jsProvider Normalization', () => {
  let provider: Web3jsProvider;
  let mockNetworkConfig: NetworkConfig;

  // Mock factories for dynamic test data generation
  const createMockWeb3Block = (overrides: any = {}) => ({
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
    ...overrides
  });

  const createMockWeb3Transaction = (overrides: any = {}) => ({
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
    ...overrides
  });

  const createMockWeb3Receipt = (overrides: any = {}) => ({
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
    ...overrides
  });

  const createMockWeb3Log = (overrides: any = {}) => ({
    address: '0xcontract123',
    topics: ['0xtopic1', '0xtopic2'],
    data: '0xlogdata',
    blockNumber: 12345n, // BigInt in v4
    transactionHash: '0xtx123',
    transactionIndex: 0n, // BigInt in v4
    blockHash: '0xblock123',
    logIndex: 0n, // BigInt in v4
    removed: false,
    ...overrides
  });

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
      const web3Block = createMockWeb3Block();
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
      const web3Block = createMockWeb3Block({
        blockNumber: 12345n,
        number: 67890n, // Should prefer blockNumber over number
      });

      const result = provider['normalizeBlock'](web3Block);
      expect(result.blockNumber).toBe(12345);
    });

    it('should fallback to number field when blockNumber is missing', () => {
      const web3Block = createMockWeb3Block({
        blockNumber: undefined,
        number: 67890n,
      });

      const result = provider['normalizeBlock'](web3Block);
      expect(result.blockNumber).toBe(67890);
    });

    it('should handle missing optional fields with defaults', () => {
      const minimalBlock = createMockWeb3Block({
        difficulty: undefined,
        totalDifficulty: undefined,
        size: undefined,
        baseFeePerGas: undefined,
        blobGasUsed: undefined,
        excessBlobGas: undefined,
        parentBeaconBlockRoot: undefined,
      });

      const result = provider['normalizeBlock'](minimalBlock);

      expect(result.difficulty).toBe('0');
      expect(result.totalDifficulty).toBe('0');
      expect(result.size).toBe(0);
      expect(result.baseFeePerGas).toBeUndefined();
      expect(result.blobGasUsed).toBeUndefined();
    });

    it('should normalize transactions in block when full objects provided', () => {
      const mockTx = createMockWeb3Transaction({
        type: 2n,
      });

      const web3Block = createMockWeb3Block({
        transactions: [mockTx],
      });

      const result = provider['normalizeBlock'](web3Block);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.hash).toBe('0xtx123');
      expect(result.transactions![0]!.type).toBe('2');
    });

    it('should handle transactions as hashes when not hydrated', () => {
      const web3Block = createMockWeb3Block({
        transactions: ['0xtx123', '0xtx456'], // String hashes when not hydrated
      });

      const result = provider['normalizeBlock'](web3Block);
      expect(result.transactions).toEqual(['0xtx123', '0xtx456']);
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

      const web3Block = createMockWeb3Block({
        withdrawals,
        withdrawalsRoot: '0xwithdrawalsroot123',
      });

      const result = provider['normalizeBlock'](web3Block);

      expect(result.withdrawals).toEqual(withdrawals);
      expect(result.withdrawalsRoot).toBe('0xwithdrawalsroot123');
    });
  });

  describe('normalizeTransaction', () => {
    it('should normalize Legacy transaction (type 0) with BigInt values', () => {
      const web3Tx = createMockWeb3Transaction();
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
      const web3Tx = createMockWeb3Transaction({
        gasPrice: undefined,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
        v: 0n,
        type: 2n,
        accessList: [],
      });

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.type).toBe('2');
      expect(result.gasPrice).toBeUndefined();
      expect(result.maxFeePerGas).toBe('30000000000');
      expect(result.maxPriorityFeePerGas).toBe('2000000000');
      expect(result.accessList).toEqual([]);
    });

    it('should normalize Blob transaction (type 3) with BigInt values', () => {
      const web3Tx = createMockWeb3Transaction({
        value: 0n,
        input: '0xblobdata',
        gasPrice: undefined,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
        maxFeePerBlobGas: 1000000000n,
        blobVersionedHashes: ['0xblob1', '0xblob2'],
        v: 0n,
        type: 3n,
      });

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.type).toBe('3');
      expect(result.maxFeePerBlobGas).toBe('1000000000');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle BigInt conversion for large values', () => {
      const web3Tx = createMockWeb3Transaction({
        nonce: 999n,
        value: 999999999999999999999999n, // Very large BigInt
        gas: 100000n,
        blockNumber: 999999n,
        transactionIndex: 55n,
        gasPrice: 50000000000n,
        chainId: 137n, // Polygon
      });

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
      const web3Tx = createMockWeb3Transaction({
        nonce: undefined,
        value: undefined,
        input: undefined,
        type: undefined,
      });

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(0);
      expect(result.value).toBe('0');
      expect(result.input).toBe('0x');
      expect(result.type).toBe('0');
    });

    it('should handle gasLimit field mapping', () => {
      const web3Tx = createMockWeb3Transaction({
        gas: undefined,
        gasLimit: 25000n,
      });

      const result = provider['normalizeTransaction'](web3Tx);
      expect(result.gas).toBe(25000);
    });

    it('should handle zero BigInt values correctly', () => {
      const web3Tx = createMockWeb3Transaction({
        nonce: 0n,
        value: 0n,
        gasPrice: 0n,
        chainId: 0n,
        blockNumber: 0n,
        transactionIndex: 0n,
      });

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(0);
      expect(result.value).toBe('0');
      expect(result.blockNumber).toBe(0);
      expect(result.transactionIndex).toBe(0);
      expect(result.gasPrice).toBe('0');
      expect(result.chainId).toBe(0);
    });

    it('should handle null and undefined values with BigInt fallbacks', () => {
      const web3Tx = createMockWeb3Transaction({
        nonce: null,
        to: null,
        value: null,
        input: null,
        gasPrice: null,
        v: null,
        r: null,
        s: null,
        type: null,
      });

      const result = provider['normalizeTransaction'](web3Tx);

      expect(result.nonce).toBe(0);
      expect(result.to).toBeNull();
      expect(result.value).toBe('0');
      expect(result.input).toBe('0x');
      expect(result.type).toBe('0');
    });
  });

  describe('normalizeReceipt', () => {
    it('should normalize web3 transaction receipt with BigInt values', () => {
      const web3Receipt = createMockWeb3Receipt();
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
      const web3Receipt = createMockWeb3Receipt({
        status: false, // Failed transaction
        type: 0n,
        effectiveGasPrice: 20000000000n,
        blobGasUsed: undefined,
        blobGasPrice: undefined,
      });

      const result = provider['normalizeReceipt'](web3Receipt);
      expect(result.status).toBe('0x0');
    });

    it('should normalize logs in receipt with BigInt values', () => {
      const mockLog = createMockWeb3Log();
      const web3Receipt = createMockWeb3Receipt({
        logs: [mockLog],
      });

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
      const web3Receipt = createMockWeb3Receipt({
        cumulativeGasUsed: 999999999n, // Large BigInt
        gasUsed: 500000000n, // Large BigInt
        effectiveGasPrice: 100000000000n, // 100 gwei as BigInt
      });

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.cumulativeGasUsed).toBe(999999999);
      expect(result.gasUsed).toBe(500000000);
      expect(result.effectiveGasPrice).toBe(100000000000);
    });

    it('should handle missing blob gas fields gracefully', () => {
      const web3Receipt = createMockWeb3Receipt({
        type: 0n,
        blobGasUsed: undefined,
        blobGasPrice: undefined,
      });

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });

    it('should handle contract creation receipts', () => {
      const web3Receipt = createMockWeb3Receipt({
        to: null,
        contractAddress: '0xnewcontract123',
      });

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.to).toBeNull();
      expect(result.contractAddress).toBe('0xnewcontract123');
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

      const web3Tx = createMockWeb3Transaction({
        type: 1n,
        accessList,
      });

      const result = provider['normalizeTransaction'](web3Tx);
      expect(result.accessList).toEqual(accessList);
    });

    it('should handle very large BigInt numbers', () => {
      const web3Tx = createMockWeb3Transaction({
        nonce: 99999999999999999999n, // Very large BigInt
        value: 123456789012345678901234567890n, // Extremely large BigInt
        gas: 99999999n,
        blockNumber: 99999999999n,
        transactionIndex: 99999n,
        gasPrice: 999999999999999999999n, // Very large BigInt
        chainId: 999999n,
      });

      const result = provider['normalizeTransaction'](web3Tx);

      expect(typeof result.nonce).toBe('number');
      expect(typeof result.gas).toBe('number');
      expect(typeof result.blockNumber).toBe('number');
      expect(typeof result.transactionIndex).toBe('number');
      expect(typeof result.chainId).toBe('number');
      expect(result.value).toBe('123456789012345678901234567890');
      expect(result.gasPrice).toBe('999999999999999999999');
    });

    it('should handle complex log structure with BigInt fields', () => {
      const complexLog = createMockWeb3Log({
        topics: ['0xtopic1', '0xtopic2', '0xtopic3', '0xtopic4'],
        data: '0x' + 'a'.repeat(128), // 64 bytes of data
        logIndex: 5n,
        removed: true,
      });

      const web3Receipt = createMockWeb3Receipt({
        logs: [complexLog],
      });

      const result = provider['normalizeReceipt'](web3Receipt);

      expect(result.logs[0]!.topics).toHaveLength(4);
      expect(result.logs[0]!.logIndex).toBe(5);
      expect(result.logs[0]!.removed).toBe(true);
    });

    it('should handle mixed transaction types in block', () => {
      const legacyTx = createMockWeb3Transaction({
        hash: '0xtx1',
        type: 0n,
        gasPrice: 20000000000n,
        maxFeePerGas: undefined,
      });

      const eip1559Tx = createMockWeb3Transaction({
        hash: '0xtx2',
        type: 2n,
        gasPrice: undefined,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
      });

      const web3Block = createMockWeb3Block({
        transactions: [legacyTx, eip1559Tx],
      });

      const result = provider['normalizeBlock'](web3Block);

      expect(result.transactions).toHaveLength(2);
      expect(result.transactions![0]!.type).toBe('0');
      expect(result.transactions![0]!.gasPrice).toBe('20000000000');
      expect(result.transactions![1]!.type).toBe('2');
      expect(result.transactions![1]!.maxFeePerGas).toBe('30000000000');
    });

    it('should handle empty arrays and null values', () => {
      const web3Block = createMockWeb3Block({
        transactions: [],
        uncles: [],
        withdrawals: null,
      });

      const result = provider['normalizeBlock'](web3Block);

      expect(result.transactions).toEqual([]);
      expect(result.uncles).toEqual([]);
      expect(result.withdrawals).toBeNull();
    });

    it('should handle undefined blockNumber and transactionIndex in pending transactions', () => {
      const pendingTx = createMockWeb3Transaction({
        blockHash: null,
        blockNumber: undefined,
        transactionIndex: undefined,
      });

      const result = provider['normalizeTransaction'](pendingTx);

      expect(result.blockHash).toBeNull();
      expect(result.blockNumber).toBeUndefined();
      expect(result.transactionIndex).toBeUndefined();
    });
  });
});