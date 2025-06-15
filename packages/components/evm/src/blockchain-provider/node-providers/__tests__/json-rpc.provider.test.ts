import { JsonRpcProvider } from '../json-rpc.provider';
import type { NetworkConfig } from '../interfaces';

describe('JsonRpcProvider Normalization', () => {
  let provider: JsonRpcProvider;
  let mockNetworkConfig: NetworkConfig;

  // Mock factories for dynamic test data generation
  const createMockRawBlock = (overrides: any = {}) => ({
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
    ...overrides
  });

  const createMockRawTransaction = (overrides: any = {}) => ({
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
    ...overrides
  });

  const createMockRawReceipt = (overrides: any = {}) => ({
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
    ...overrides
  });

  const createMockRawLog = (overrides: any = {}) => ({
    address: '0xcontract123',
    topics: ['0xtopic1', '0xtopic2'],
    data: '0xlogdata',
    blockNumber: '0x3039',
    transactionHash: '0xtx123',
    transactionIndex: '0x0',
    blockHash: '0xblock123',
    logIndex: '0x5',
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

    provider = new JsonRpcProvider({
      uniqName: 'w',
      httpUrl: 'http://localhost:8545',
      network: mockNetworkConfig,
    });
  });

  describe('normalizeRawBlock', () => {
    it('should normalize block with hex values', () => {
      const rawBlock = createMockRawBlock();
      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.blockNumber).toBe(12345);
      expect(result.size).toBe(1024);
      expect(result.gasLimit).toBe(30000000);
      expect(result.gasUsed).toBe(15000000);
      expect(result.baseFeePerGas).toBe('0x4a817c800');
      expect(result.blobGasUsed).toBe('0x20000');
      expect(result.difficulty).toBe('0xf4240');
      expect(result.totalDifficulty).toBe('0x4c4b40');
    });

    it('should handle blockNumber vs number fields', () => {
      const rawBlock = createMockRawBlock({
        blockNumber: '0x3039',
        number: undefined,
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.blockNumber).toBe(12345);
    });

    it('should fallback to number field when blockNumber is missing', () => {
      const rawBlock = createMockRawBlock({
        blockNumber: undefined,
        number: '0x10a91', // 68241
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.blockNumber).toBe(68241);
    });

    it('should handle zero blockNumber', () => {
      const rawBlock = createMockRawBlock({
        number: '0x0',
        blockNumber: undefined,
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.blockNumber).toBe(0);
    });

    it('should handle transactions as strings or objects', () => {
      const rawBlock = createMockRawBlock({
        transactions: ['0xtx1', '0xtx2'],
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.transactions).toEqual(['0xtx1', '0xtx2']);
    });

    it('should normalize transaction objects in block', () => {
      const mockTx = createMockRawTransaction();
      const rawBlock = createMockRawBlock({
        transactions: [mockTx],
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.hash).toBe('0xtx123');
      expect(result.transactions![0]!.nonce).toBe(42);
    });

    it('should handle missing optional fields', () => {
      const rawBlock = createMockRawBlock({
        difficulty: undefined,
        totalDifficulty: undefined,
        baseFeePerGas: undefined,
        blobGasUsed: undefined,
        excessBlobGas: undefined,
        parentBeaconBlockRoot: undefined,
        withdrawals: undefined,
        withdrawalsRoot: undefined,
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.difficulty).toBeUndefined();
      expect(result.totalDifficulty).toBeUndefined();
      expect(result.baseFeePerGas).toBeUndefined();
      expect(result.blobGasUsed).toBeUndefined();
    });

    it('should handle withdrawals', () => {
      const withdrawals = [
        { index: '0x1', validatorIndex: '0x2', address: '0xvalidator1', amount: '0x3b9aca00' },
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
    it('should normalize Legacy transaction', () => {
      const rawTx = createMockRawTransaction();
      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.nonce).toBe(42);
      expect(result.gas).toBe(21000);
      expect(result.blockNumber).toBe(12345);
      expect(result.transactionIndex).toBe(0);
      expect(result.chainId).toBe(1);
      expect(result.type).toBe('0x0');
      expect(result.gasPrice).toBe('0x4a817c800');
      expect(result.value).toBe('0xde0b6b3a7640000');
    });

    it('should normalize EIP-1559 transaction', () => {
      const rawTx = createMockRawTransaction({
        gasPrice: undefined,
        maxFeePerGas: '0x6fc23ac00',
        maxPriorityFeePerGas: '0x77359400',
        v: '0x0',
        type: '0x2',
        accessList: [],
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x2');
      expect(result.maxFeePerGas).toBe('0x6fc23ac00');
      expect(result.maxPriorityFeePerGas).toBe('0x77359400');
      expect(result.gasPrice).toBeUndefined();
      expect(result.accessList).toEqual([]);
    });

    it('should normalize Blob transaction', () => {
      const rawTx = createMockRawTransaction({
        value: '0x0',
        input: '0xblobdata',
        gasPrice: undefined,
        maxFeePerGas: '0x6fc23ac00',
        maxPriorityFeePerGas: '0x77359400',
        maxFeePerBlobGas: '0x3b9aca00',
        blobVersionedHashes: ['0xblob1', '0xblob2'],
        v: '0x0',
        type: '0x3',
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x3');
      expect(result.maxFeePerBlobGas).toBe('0x3b9aca00');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle missing fields with defaults', () => {
      const rawTx = createMockRawTransaction({
        blockNumber: undefined,
        transactionIndex: undefined,
        chainId: undefined,
        type: undefined,
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x0');
      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
      expect(result.chainId).toBeUndefined();
    });

    it('should handle zero values correctly', () => {
      const rawTx = createMockRawTransaction({
        nonce: '0x0',
        value: '0x0',
        gas: '0x0',
        blockNumber: '0x0',
        transactionIndex: '0x0',
        gasPrice: '0x0',
        chainId: '0x0',
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.nonce).toBe(0);
      expect(result.gas).toBe(0);
      expect(result.blockNumber).toBe(0);
      expect(result.transactionIndex).toBe(0);
      expect(result.chainId).toBe(0);
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

    it('should throw error for malformed hex', () => {
      const rawTx = createMockRawTransaction({
        nonce: '0xGGG', // Invalid hex
      });

      expect(() => {
        provider['normalizeRawTransaction'](rawTx);
      }).toThrow();
    });

    it('should handle large hex values', () => {
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
  });

  describe('normalizeRawReceipt', () => {
    it('should normalize receipt', () => {
      const rawReceipt = createMockRawReceipt();
      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.transactionIndex).toBe(0);
      expect(result.blockNumber).toBe(12345);
      expect(result.status).toBe('0x1');
      expect(result.cumulativeGasUsed).toBe(21000);
      expect(result.gasUsed).toBe(21000);
      expect(result.blobGasUsed).toBe('0x20000');
      expect(result.type).toBe('0x2');
    });

    it('should handle failed transaction', () => {
      const rawReceipt = createMockRawReceipt({
        status: '0x0',
        type: '0x0',
        effectiveGasPrice: '0x4a817c800',
        blobGasUsed: undefined,
        blobGasPrice: undefined,
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);
      expect(result.status).toBe('0x0');
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
        blockNumber: 12345,
        transactionHash: '0xtx123',
        transactionIndex: 0,
        blockHash: '0xblock123',
        logIndex: 5,
        removed: false,
      });
    });

    it('should handle missing effectiveGasPrice', () => {
      const rawReceipt = createMockRawReceipt({
        effectiveGasPrice: undefined,
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);
      expect(result.effectiveGasPrice).toBe(0);
    });

    it('should handle contract creation receipt', () => {
      const rawReceipt = createMockRawReceipt({
        to: null,
        contractAddress: '0xnewcontract123',
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.to).toBeNull();
      expect(result.contractAddress).toBe('0xnewcontract123');
    });

    it('should handle large gas values', () => {
      const rawReceipt = createMockRawReceipt({
        cumulativeGasUsed: '0x3b9aca00', // 1 billion
        gasUsed: '0x1dcd6500', // 500 million
        effectiveGasPrice: '0x174876e800', // 100 gwei
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.cumulativeGasUsed).toBe(1000000000);
      expect(result.gasUsed).toBe(500000000);
      expect(result.effectiveGasPrice).toBe(100000000000);
    });
  });

  describe('normalizeRawLog', () => {
    it('should normalize log', () => {
      const rawLog = createMockRawLog();
      const result = provider['normalizeRawLog'](rawLog);

      expect(result.blockNumber).toBe(12345);
      expect(result.transactionIndex).toBe(0);
      expect(result.logIndex).toBe(5);
      expect(result.removed).toBe(false);
      expect(result.address).toBe('0xcontract123');
      expect(result.topics).toEqual(['0xtopic1', '0xtopic2']);
      expect(result.data).toBe('0xlogdata');
    });

    it('should handle missing fields', () => {
      const rawLog = createMockRawLog({
        blockNumber: undefined,
        transactionIndex: undefined,
        logIndex: undefined,
        blockHash: undefined,
      });

      const result = provider['normalizeRawLog'](rawLog);

      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
      expect(result.logIndex).toBeNull();
      expect(result.blockHash).toBeUndefined();
      expect(result.removed).toBe(false);
    });

    it('should handle complex log with multiple topics', () => {
      const rawLog = createMockRawLog({
        topics: ['0xtopic1', '0xtopic2', '0xtopic3', '0xtopic4'],
        data: '0x' + 'a'.repeat(128), // 64 bytes of data
        logIndex: '0xa', // 10
        removed: true,
      });

      const result = provider['normalizeRawLog'](rawLog);

      expect(result.topics).toHaveLength(4);
      expect(result.logIndex).toBe(10);
      expect(result.removed).toBe(true);
      expect(result.data.length).toBe(130); // 0x + 128 chars
    });

    it('should handle zero values', () => {
      const rawLog = createMockRawLog({
        blockNumber: '0x0',
        transactionIndex: '0x0',
        logIndex: '0x0',
      });

      const result = provider['normalizeRawLog'](rawLog);

      expect(result.blockNumber).toBe(0);
      expect(result.transactionIndex).toBe(0);
      expect(result.logIndex).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very large block numbers', () => {
      const rawBlock = createMockRawBlock({
        number: '0xffffffffff', // Very large block number
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(typeof result.blockNumber).toBe('number');
      expect(result.blockNumber).toBeGreaterThan(0);
    });

    it('should handle empty transaction arrays', () => {
      const rawBlock = createMockRawBlock({
        transactions: [],
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.transactions).toEqual([]);
    });

    it('should handle mixed transaction format in block', () => {
      const mockTxHash = '0xtxhash123';
      const mockTxObject = createMockRawTransaction({
        hash: '0xtxobject456',
      });

      const rawBlock = createMockRawBlock({
        transactions: [mockTxHash, mockTxObject],
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.transactions).toHaveLength(2);
      expect(result.transactions![0]).toBe('0xtxhash123');
      expect(typeof result.transactions![1]).toBe('object');
      expect(result.transactions![1]!.hash).toBe('0xtxobject456');
    });

    it('should handle pending transactions with null block data', () => {
      const rawTx = createMockRawTransaction({
        blockHash: null,
        blockNumber: null,
        transactionIndex: null,
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.blockHash).toBeNull();
      expect(result.blockNumber).toBeNull();
      expect(result.transactionIndex).toBeNull();
    });

    it('should handle receipts with empty logs array', () => {
      const rawReceipt = createMockRawReceipt({
        logs: [],
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);
      expect(result.logs).toEqual([]);
    });

    it('should handle receipts with multiple logs', () => {
      const log1 = createMockRawLog({
        logIndex: '0x0',
        address: '0xcontract1',
      });
      const log2 = createMockRawLog({
        logIndex: '0x1',
        address: '0xcontract2',
        topics: ['0xdifferenttopic'],
      });

      const rawReceipt = createMockRawReceipt({
        logs: [log1, log2],
      });

      const result = provider['normalizeRawReceipt'](rawReceipt);

      expect(result.logs).toHaveLength(2);
      expect(result.logs[0]!.logIndex).toBe(0);
      expect(result.logs[1]!.logIndex).toBe(1);
      expect(result.logs[0]!.address).toBe('0xcontract1');
      expect(result.logs[1]!.address).toBe('0xcontract2');
    });

    it('should handle transactions with missing optional EIP-1559 fields', () => {
      const rawTx = createMockRawTransaction({
        type: '0x2',
        gasPrice: undefined,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x2');
      expect(result.gasPrice).toBeUndefined();
      expect(result.maxFeePerGas).toBeUndefined();
      expect(result.maxPriorityFeePerGas).toBeUndefined();
    });

    it('should handle blocks with all EIP-4844 fields', () => {
      const rawBlock = createMockRawBlock({
        blobGasUsed: '0x40000', // 262144
        excessBlobGas: '0x20000', // 131072
        parentBeaconBlockRoot: '0xbeaconroot456',
      });

      const result = provider['normalizeRawBlock'](rawBlock);

      expect(result.blobGasUsed).toBe('0x40000');
      expect(result.excessBlobGas).toBe('0x20000');
      expect(result.parentBeaconBlockRoot).toBe('0xbeaconroot456');
    });

    it('should handle blob transactions with all fields', () => {
      const rawTx = createMockRawTransaction({
        type: '0x3',
        maxFeePerBlobGas: '0x5f5e100', // 100 gwei
        blobVersionedHashes: [
          '0x01abcdef123456789abcdef123456789abcdef123456789abcdef123456789abc',
          '0x01fedcba987654321fedcba987654321fedcba987654321fedcba987654321fed'
        ],
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      expect(result.type).toBe('0x3');
      expect(result.maxFeePerBlobGas).toBe('0x5f5e100');
      expect(result.blobVersionedHashes).toHaveLength(2);
    });

    it('should handle status field edge cases', () => {
      // Test different status representations
      const successReceipt = createMockRawReceipt({ status: '0x1' });
      const failureReceipt = createMockRawReceipt({ status: '0x0' });
      const nullReceipt = createMockRawReceipt({ status: null });

      expect(provider['normalizeRawReceipt'](successReceipt).status).toBe('0x1');
      expect(provider['normalizeRawReceipt'](failureReceipt).status).toBe('0x0');
      expect(provider['normalizeRawReceipt'](nullReceipt).status).toBe('0x0');
    });

    it('should handle type field defaults', () => {
      const rawTx = createMockRawTransaction({
        type: undefined,
      });

      const rawReceipt = createMockRawReceipt({
        type: undefined,
      });

      expect(provider['normalizeRawTransaction'](rawTx).type).toBe('0x0');
      expect(provider['normalizeRawReceipt'](rawReceipt).type).toBe('0x0');
    });

    it('should preserve hex string formats for certain fields', () => {
      const rawTx = createMockRawTransaction({
        value: '0xde0b6b3a7640000', // 1 ETH in wei
        gasPrice: '0x4a817c800', // 20 gwei
      });

      const result = provider['normalizeRawTransaction'](rawTx);

      // These should remain as hex strings
      expect(result.value).toBe('0xde0b6b3a7640000');
      expect(result.gasPrice).toBe('0x4a817c800');
    });

    it('should handle uncle arrays', () => {
      const uncles = ['0xuncle1', '0xuncle2'];
      const rawBlock = createMockRawBlock({
        uncles,
      });

      const result = provider['normalizeRawBlock'](rawBlock);
      expect(result.uncles).toEqual(uncles);
    });
  });
});