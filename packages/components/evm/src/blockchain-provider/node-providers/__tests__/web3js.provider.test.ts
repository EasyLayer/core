import { Web3jsProvider } from '../web3js.provider';
import type { NetworkConfig } from '../interfaces';

describe('Web3jsProvider Normalization', () => {
  let provider: Web3jsProvider;
  let mockNetworkConfig: NetworkConfig;

  // Mock factories for raw JSON-RPC response data
  const createMockRawBlock = (overrides: any = {}) => ({
    hash: '0xabc123',
    parentHash: '0xdef456',
    number: '0x10ac7', // 68199 in hex (из ошибки)
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x00000000000000000000000000000000',
    transactionsRoot: '0x789abc',
    stateRoot: '0xstate123',
    receiptsRoot: '0xreceipts456',
    miner: '0xminer789',
    difficulty: '0xf4240', // 1000000 in hex
    totalDifficulty: '0x4c4b40', // 5000000 in hex
    extraData: '0x',
    size: '0x400', // 1024 in hex
    gasLimit: '0x1c9c380', // 30000000 in hex
    gasUsed: '0xe4e1c0', // 15000000 in hex
    timestamp: '0x61aa4f00', // 1638889984 in hex (из ошибки)
    uncles: [],
    baseFeePerGas: '0x4a817c800', // 20000000000 in hex
    blobGasUsed: '0x20000', // 131072 in hex
    excessBlobGas: '0x0',
    parentBeaconBlockRoot: '0xbeacon123',
    transactions: [],
    ...overrides
  });

  const createMockRawTransaction = (overrides: any = {}) => ({
    hash: '0xtx123',
    nonce: '0x2a', // 42 in hex
    from: '0xfrom123',
    to: '0xto456',
    value: '0xde0b6b3a7640000', // 1000000000000000000 in hex (1 ETH)
    gas: '0x5208', // 21000 in hex
    input: '0x',
    blockHash: '0xblock123',
    blockNumber: '0x10ac7', // 68199 in hex
    transactionIndex: '0x0',
    gasPrice: '0x4a817c800', // 20000000000 in hex
    chainId: '0x1',
    v: '0x1b', // 27 in hex
    r: '0xr123',
    s: '0xs456',
    type: '0x0',
    ...overrides
  });

  const createMockRawReceipt = (overrides: any = {}) => ({
    transactionHash: '0xtx123',
    transactionIndex: '0x0',
    blockHash: '0xblock123',
    blockNumber: '0x10ac7', // 68199 in hex
    from: '0xfrom123',
    to: '0xto456',
    cumulativeGasUsed: '0x5208', // 21000 in hex
    gasUsed: '0x5208', // 21000 in hex
    contractAddress: null,
    logs: [],
    logsBloom: '0x00000000000000000000000000000000',
    status: '0x1',
    type: '0x2',
    effectiveGasPrice: '0x5d21dba00', // 25000000000 in hex
    blobGasUsed: '0x20000', // 131072 in hex
    blobGasPrice: '0x3b9aca00', // 1000000000 in hex
    ...overrides
  });

  const createMockRawLog = (overrides: any = {}) => ({
    address: '0xcontract123',
    topics: ['0xtopic1', '0xtopic2'],
    data: '0xlogdata',
    blockNumber: '0x10ac7', // 68199 in hex
    transactionHash: '0xtx123',
    transactionIndex: '0x0',
    blockHash: '0xblock123',
    logIndex: '0x0',
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
      maxBlockSize: 30000000,
      maxBlockWeight: 30000000,
      maxGasLimit: 30000000,
      maxTransactionSize: 1000000,
      minGasPrice: 1000000000,
      maxBaseFeePerGas: 1000000000000,
      maxPriorityFeePerGas: 100000000000,
      maxBlobGasPerBlock: 786432,
      targetBlobGasPerBlock: 393216,
      maxCodeSize: 24576,
      maxInitCodeSize: 49152,
    };

    provider = new Web3jsProvider({
      uniqName: 'w',
      httpUrl: 'http://localhost:8545',
      network: mockNetworkConfig,
      rateLimits: {}
    });
  });

  describe('normalizeRawBlock', () => {
    it('should normalize raw JSON-RPC block response', () => {
      const rawBlock = createMockRawBlock();
      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result).toEqual({
        hash: '0xabc123',
        parentHash: '0xdef456',
        blockNumber: 68295,
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
        size: 1024,
        gasLimit: 30000000,
        gasUsed: 15000000,
        timestamp: 1638551296,
        uncles: [],
        baseFeePerGas: '0x4a817c800',
        withdrawals: undefined,
        withdrawalsRoot: undefined,
        blobGasUsed: '0x20000',
        excessBlobGas: '0x0',
        parentBeaconBlockRoot: '0xbeacon123',
        transactions: [],
      });
    });

    it('should prefer blockNumber over number field', () => {
      const rawBlock = createMockRawBlock({
        blockNumber: '0x10a67', // 68103 in hex
        number: '0x109a7', // 67687 in hex - should be ignored
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.blockNumber).toBe(68199);
    });

    it('should fallback to number field when blockNumber missing', () => {
      const rawBlock = createMockRawBlock({
        blockNumber: undefined,
        number: '0x10b27', // 68391 in hex
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.blockNumber).toBe(68391);
    });

    it('should handle missing optional fields', () => {
      const minimalBlock = createMockRawBlock({
        baseFeePerGas: undefined,
        blobGasUsed: undefined,
        excessBlobGas: undefined,
        parentBeaconBlockRoot: undefined,
        withdrawals: undefined,
        withdrawalsRoot: undefined,
      });

      const result = provider['normalizeRawBlock'](minimalBlock);

      expect(result.baseFeePerGas).toBeUndefined();
      expect(result.blobGasUsed).toBeUndefined();
      expect(result.excessBlobGas).toBeUndefined();
      expect(result.parentBeaconBlockRoot).toBeUndefined();
      expect(result.withdrawals).toBeUndefined();
      expect(result.withdrawalsRoot).toBeUndefined();
    });

    it('should normalize transaction objects in block', () => {
      const rawTransaction = createMockRawTransaction();
      const rawBlock = createMockRawBlock({
        transactions: [rawTransaction],
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]).toMatchObject({
        hash: '0xtx123',
        nonce: 42,
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: 21000,
      });
    });

    it('should handle transactions as hashes when not hydrated', () => {
      const rawBlock = createMockRawBlock({
        transactions: ['0xtx123', '0xtx456'], // String hashes
      });

      const result = provider['normalizeRawBlock'](rawBlock);
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

      const rawBlock = createMockRawBlock({
        withdrawals,
        withdrawalsRoot: '0xwithdrawalsroot123',
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.withdrawals).toEqual(withdrawals);
      expect(result.withdrawalsRoot).toBe('0xwithdrawalsroot123');
    });
  });

  describe('normalizeRawTransaction', () => {
    it('should normalize raw JSON-RPC transaction response', () => {
      const rawTx = createMockRawTransaction();
      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result).toEqual({
        hash: '0xtx123',
        nonce: 42,
        from: '0xfrom123',
        to: '0xto456',
        value: '0xde0b6b3a7640000',
        gas: 21000,
        input: '0x',
        blockHash: '0xblock123',
        blockNumber: 68295,
        transactionIndex: 0,
        gasPrice: '0x4a817c800',
        chainId: 1,
        v: '0x1b',
        r: '0xr123',
        s: '0xs456',
        type: '0x0',
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
        accessList: undefined,
        maxFeePerBlobGas: undefined,
        blobVersionedHashes: undefined,
      });
    });

    it('should handle EIP-1559 transaction fields', () => {
      const rawTx = createMockRawTransaction({
        type: '0x2',
        gasPrice: undefined,
        maxFeePerGas: '0x6fc23ac00', // 30000000000 in hex
        maxPriorityFeePerGas: '0x77359400', // 2000000000 in hex
        accessList: [],
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x2');
      expect(result.gasPrice).toBeUndefined();
      expect(result.maxFeePerGas).toBe('0x6fc23ac00');
      expect(result.maxPriorityFeePerGas).toBe('0x77359400');
      expect(result.accessList).toEqual([]);
    });

    it('should handle blob transaction fields', () => {
      const rawTx = createMockRawTransaction({
        type: '0x3',
        maxFeePerBlobGas: '0x3b9aca00', // 1000000000 in hex
        blobVersionedHashes: ['0xblob1', '0xblob2'],
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x3');
      expect(result.maxFeePerBlobGas).toBe('0x3b9aca00');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle missing or invalid hex values with defaults', () => {
      const rawTx = createMockRawTransaction({
        nonce: undefined,
        gas: '',
        blockNumber: undefined,
        transactionIndex: null,
        chainId: undefined,
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.nonce).toBe(0);
      expect(result.gas).toBe(0);
      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
      expect(result.chainId).toBeUndefined();
    });

    it('should handle access list', () => {
      const accessList = [
        { address: '0xcontract1', storageKeys: ['0xkey1', '0xkey2'] },
        { address: '0xcontract2', storageKeys: ['0xkey3'] },
      ];

      const rawTx = createMockRawTransaction({
        type: '0x1',
        accessList,
      });

      const result = provider['normalizeRawTransaction'](rawTx);
      expect(result.accessList).toEqual(accessList);
    });

    it('should default type to 0x0 when missing', () => {
      const rawTx = createMockRawTransaction({
        type: undefined,
      });

      const result = provider['normalizeRawTransaction'](rawTx);
      expect(result.type).toBe('0x0');
    });
  });

  describe('normalizeRawReceipt', () => {
    it('should normalize raw JSON-RPC receipt response', () => {
      const rawReceipt = createMockRawReceipt();
      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result).toEqual({
        transactionHash: '0xtx123',
        transactionIndex: 0,
        blockHash: '0xblock123',
        blockNumber: 68295,
        from: '0xfrom123',
        to: '0xto456',
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [],
        logsBloom: '0x00000000000000000000000000000000',
        status: '0x1',
        type: '0x2',
        effectiveGasPrice: 25000000000,
        blobGasUsed: '0x20000',
        blobGasPrice: '0x3b9aca00',
      });
    });

    it('should handle failed transaction status', () => {
      const rawReceipt = createMockRawReceipt({
        status: '0x0',
        type: '0x0',
        blobGasUsed: undefined,
        blobGasPrice: undefined,
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);
      expect(result.status).toBe('0x0');
      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });

    it('should normalize logs in receipt', () => {
      const mockLog = createMockRawLog();
      const rawReceipt = createMockRawReceipt({
        logs: [mockLog],
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).toEqual({
        address: '0xcontract123',
        topics: ['0xtopic1', '0xtopic2'],
        data: '0xlogdata',
        blockNumber: 68295,
        transactionHash: '0xtx123',
        transactionIndex: 0,
        blockHash: '0xblock123',
        logIndex: 0,
        removed: false,
      });
    });

    it('should handle missing optional fields with defaults', () => {
      const rawReceipt = createMockRawReceipt({
        type: undefined,
        effectiveGasPrice: undefined,
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.type).toBe('0x0');
      expect(result.effectiveGasPrice).toBe(0);
    });

    it('should handle logs with missing optional fields', () => {
      const logWithMissingFields = createMockRawLog({
        blockNumber: undefined,
        transactionIndex: undefined,
        logIndex: undefined,
      });

      const rawReceipt = createMockRawReceipt({
        logs: [logWithMissingFields],
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.logs[0]!.blockNumber).toBeNull();
      expect(result.logs[0]!.transactionIndex).toBeNull();
      expect(result.logs[0]!.logIndex).toBeNull();
    });
  });

  describe('normalizeBlockStats', () => {
    it('should normalize raw block data into block stats', () => {
      const rawBlock = createMockRawBlock({
        transactions: ['0xtx1', '0xtx2', '0xtx3'], // 3 transactions
        uncles: ['0xuncle1'], // 1 uncle
      });

      const result = provider['normalizeBlockStats'](rawBlock);

      expect(result).toEqual({
        hash: '0xabc123',
        number: 68295,
        size: 1024,
        gasLimit: 30000000,
        gasUsed: 15000000,
        gasUsedPercentage: 50, // (15000000 / 30000000) * 100
        timestamp: 1638551296,
        transactionCount: 3,
        baseFeePerGas: '0x4a817c800',
        blobGasUsed: '0x20000',
        excessBlobGas: '0x0',
        miner: '0xminer789',
        difficulty: '0xf4240',
        parentHash: '0xdef456',
        unclesCount: 1,
      });
    });

    it('should handle missing transactions and calculate 0 count', () => {
      const rawBlock = createMockRawBlock({
        transactions: undefined,
        uncles: undefined,
      });

      const result = provider['normalizeBlockStats'](rawBlock);

      expect(result.transactionCount).toBe(0);
      expect(result.unclesCount).toBe(0);
    });

    it('should calculate gas percentage correctly with zero gas limit', () => {
      const rawBlock = createMockRawBlock({
        gasLimit: '0x0',
        gasUsed: '0x5208',
      });

      const result = provider['normalizeBlockStats'](rawBlock);

      expect(result.gasUsedPercentage).toBe(0);
    });

    it('should prefer number over blockNumber field in stats', () => {
      const rawBlock = createMockRawBlock({
        number: '0x10b27', // 68391 in hex
        blockNumber: '0x109a7', // 67687 in hex - should be ignored
      });

      const result = provider['normalizeBlockStats'](rawBlock);
      expect(result.number).toBe(68391);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very large hex values', () => {
      const rawTx = createMockRawTransaction({
        nonce: '0xffffffffffffffff', // Max uint64
        gas: '0xffffffff', // Max uint32
        value: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // Max uint256
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(typeof result.nonce).toBe('number');
      expect(typeof result.gas).toBe('number');
      expect(typeof result.value).toBe('string');
    });

    it('should handle invalid hex values gracefully', () => {
      const rawTx = createMockRawTransaction({
        nonce: 'invalid',
        gas: '',
        chainId: 'not-hex',
      });

      expect(() => provider['normalizeRawTransaction'](rawTx)).toThrow();
    });

    it('should handle null and undefined gas values', () => {
      const rawReceipt = createMockRawReceipt({
        cumulativeGasUsed: undefined,
        gasUsed: null,
        effectiveGasPrice: '',
      });

      // Should not throw but handle gracefully
      expect(() => provider['normalizeRawReceipt'](rawReceipt)).not.toThrow();
    });

    it('should handle empty arrays and null values', () => {
      const rawBlock = createMockRawBlock({
        transactions: [],
        uncles: [],
        withdrawals: null,
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.transactions).toEqual([]);
      expect(result.uncles).toEqual([]);
      expect(result.withdrawals).toBeNull();
    });

    it('should handle mixed transaction types in block', () => {
      const legacyTx = createMockRawTransaction({
        hash: '0xtx1',
        type: '0x0',
        gasPrice: '0x4a817c800',
        maxFeePerGas: undefined,
      });

      const eip1559Tx = createMockRawTransaction({
        hash: '0xtx2',
        type: '0x2',
        gasPrice: undefined,
        maxFeePerGas: '0x6fc23ac00',
        maxPriorityFeePerGas: '0x77359400',
      });

      const rawBlock = createMockRawBlock({
        transactions: [legacyTx, eip1559Tx],
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.transactions).toHaveLength(2);
      expect(result.transactions![0]!.type).toBe('0x0');
      expect(result.transactions![0]!.gasPrice).toBe('0x4a817c800');
      expect(result.transactions![1]!.type).toBe('0x2');
      expect(result.transactions![1]!.maxFeePerGas).toBe('0x6fc23ac00');
    });

    it('should handle contract creation receipts', () => {
      const rawReceipt = createMockRawReceipt({
        to: null,
        contractAddress: '0xnewcontract123',
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.to).toBeNull();
      expect(result.contractAddress).toBe('0xnewcontract123');
    });

    it('should handle complex log structure', () => {
      const complexLog = createMockRawLog({
        topics: ['0xtopic1', '0xtopic2', '0xtopic3', '0xtopic4'],
        data: '0x' + 'a'.repeat(128), // 64 bytes of data
        logIndex: '0x5', // 5 in hex
        removed: true,
      });

      const rawReceipt = createMockRawReceipt({
        logs: [complexLog],
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.logs[0]!.topics).toHaveLength(4);
      expect(result.logs[0]!.logIndex).toBe(5);
      expect(result.logs[0]!.removed).toBe(true);
    });

    it('should handle pending transactions with null block fields', () => {
      const pendingTx = createMockRawTransaction({
        blockHash: null,
        blockNumber: undefined,
        transactionIndex: undefined,
      });

      const result = provider['normalizeRawTransaction'](pendingTx);

      expect(result.blockHash).toBeNull();
      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
    });
  });
});