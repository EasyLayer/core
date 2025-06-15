import { EtherJSProvider } from '../etherjs.provider';
import type { NetworkConfig } from '../interfaces';

describe('EtherJSProvider Normalization', () => {
  let provider: EtherJSProvider;
  let mockNetworkConfig: NetworkConfig;

  // Mock factories for dynamic test data generation
  const createMockEthersBlock = (overrides: any = {}) => ({
    hash: '0xabc123',
    parentHash: '0xdef456',
    number: 12345,
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x00000000000000000000000000000000',
    transactionsRoot: '0x789abc',
    stateRoot: '0xstate123',
    receiptsRoot: '0xreceipts456',
    miner: '0xminer789',
    difficulty: 1000000n,
    totalDifficulty: 5000000n,
    extraData: '0x',
    size: 1024,
    gasLimit: 30000000n,
    gasUsed: 15000000n,
    timestamp: 1640995200,
    uncles: [],
    baseFeePerGas: 20000000000n,
    blobGasUsed: 131072n,
    excessBlobGas: 0n,
    parentBeaconBlockRoot: '0xbeacon123',
    transactions: ['0xtx1', '0xtx2'],
    ...overrides
  });

  const createMockEthersTransaction = (overrides: any = {}) => ({
    hash: '0xtx123',
    nonce: 42,
    from: '0xfrom123',
    to: '0xto456',
    value: 1000000000000000000n,
    gasLimit: 21000n,
    data: '0x',
    blockHash: '0xblock123',
    blockNumber: 12345,
    transactionIndex: 0,
    gasPrice: 20000000000n,
    chainId: 1n,
    signature: {
      v: 27,
      r: '0xr123',
      s: '0xs456',
    },
    type: 0,
    ...overrides
  });

  const createMockEthersReceipt = (overrides: any = {}) => ({
    transactionHash: '0xtx123',
    transactionIndex: 0,
    blockHash: '0xblock123',
    blockNumber: 12345,
    from: '0xfrom123',
    to: '0xto456',
    cumulativeGasUsed: 21000n,
    gasUsed: 21000n,
    contractAddress: null,
    logs: [],
    logsBloom: '0x00000000000000000000000000000000',
    status: 1,
    type: 2,
    effectiveGasPrice: 25000000000n,
    blobGasUsed: 131072n,
    blobGasPrice: 1000000000n,
    ...overrides
  });

  const createMockLog = (overrides: any = {}) => ({
    address: '0xcontract123',
    topics: ['0xtopic1', '0xtopic2'],
    data: '0xlogdata',
    blockNumber: 12345,
    transactionHash: '0xtx123',
    transactionIndex: 0,
    blockHash: '0xblock123',
    logIndex: 0,
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

    provider = new EtherJSProvider({
      uniqName: 'e',
      httpUrl: 'http://localhost:8545',
      network: mockNetworkConfig,
    });
  });

  describe('normalizeBlock', () => {
    it('should normalize ethers block with BigInt values', () => {
      const ethersBlock = createMockEthersBlock();
      const result = provider['normalizeBlock'](ethersBlock);

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
        transactions: ['0xtx1', '0xtx2'],
      });
    });

    it('should handle missing optional fields', () => {
      const minimalBlock = createMockEthersBlock({
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

    it('should normalize transactions in block when only hashes provided', () => {
      const ethersBlock = createMockEthersBlock({
        transactions: ['0xtx123', '0xtx456'],
      });

      const result = provider['normalizeBlock'](ethersBlock);
      expect(result.transactions).toEqual(['0xtx123', '0xtx456']);
    });

    it('should normalize prefetchedTransactions from ethers v6', () => {
      const mockTransaction = createMockEthersTransaction({
        type: 2,
        blockHash: '0xabc123',
        blockNumber: 12345,
        transactionIndex: 0,
      });

      const ethersBlock = createMockEthersBlock({
        transactions: ['0xtx123'],
        prefetchedTransactions: [mockTransaction],
      });

      const result = provider['normalizeBlock'](ethersBlock);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]).toMatchObject({
        hash: '0xtx123',
        nonce: 42,
        from: '0xfrom123',
        to: '0xto456',
        value: '1000000000000000000',
        gas: 21000,
        input: '0x',
        type: '2',
      });
    });

    it('should prioritize prefetchedTransactions over regular transactions', () => {
      const mockTransaction1 = createMockEthersTransaction({
        hash: '0xtx123',
        type: 2,
      });
      const mockTransaction2 = createMockEthersTransaction({
        hash: '0xtx456',
        nonce: 43,
        from: '0xfrom456',
        to: '0xto789',
        value: 2000000000000000000n,
        gasLimit: 25000n,
        data: '0xdata',
        type: 0,
      });

      const ethersBlock = createMockEthersBlock({
        transactions: ['0xtx123', '0xtx456'],
        prefetchedTransactions: [mockTransaction1, mockTransaction2],
      });

      const result = provider['normalizeBlock'](ethersBlock);

      expect(result.transactions).toHaveLength(2);
      expect(typeof result.transactions![0]).toBe('object');
      expect(result.transactions![0]!.hash).toBe('0xtx123');
      expect(result.transactions![1]!.hash).toBe('0xtx456');
    });

    it('should handle empty prefetchedTransactions array', () => {
      const ethersBlock = createMockEthersBlock({
        transactions: ['0xtx123', '0xtx456'],
        prefetchedTransactions: [],
      });

      const result = provider['normalizeBlock'](ethersBlock);
      expect(result.transactions).toEqual(['0xtx123', '0xtx456']);
    });

    it('should handle block without any transactions', () => {
      const ethersBlock = createMockEthersBlock({
        transactions: undefined,
      });

      const result = provider['normalizeBlock'](ethersBlock);
      expect(result.transactions).toBeUndefined();
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

      const ethersBlock = createMockEthersBlock({
        withdrawals,
        withdrawalsRoot: '0xwithdrawalsroot123',
      });

      const result = provider['normalizeBlock'](ethersBlock);

      expect(result.withdrawals).toEqual(withdrawals);
      expect(result.withdrawalsRoot).toBe('0xwithdrawalsroot123');
    });
  });

  describe('normalizeTransaction', () => {
    it('should normalize Legacy transaction (type 0)', () => {
      const ethersTx = createMockEthersTransaction();
      const result = provider['normalizeTransaction'](ethersTx);

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
      const ethersTx = createMockEthersTransaction({
        gasPrice: undefined,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
        signature: { v: 0, r: '0xr123', s: '0xs456' },
        type: 2,
        accessList: [],
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(result.type).toBe('2');
      expect(result.gasPrice).toBeUndefined();
      expect(result.maxFeePerGas).toBe('30000000000');
      expect(result.maxPriorityFeePerGas).toBe('2000000000');
      expect(result.accessList).toEqual([]);
    });

    it('should normalize Blob transaction (type 3)', () => {
      const ethersTx = createMockEthersTransaction({
        value: 0n,
        data: '0xblobdata',
        gasPrice: undefined,
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 2000000000n,
        maxFeePerBlobGas: 1000000000n,
        blobVersionedHashes: ['0xblob1', '0xblob2'],
        signature: { v: 0, r: '0xr123', s: '0xs456' },
        type: 3,
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(result.type).toBe('3');
      expect(result.maxFeePerBlobGas).toBe('1000000000');
      expect(result.blobVersionedHashes).toEqual(['0xblob1', '0xblob2']);
    });

    it('should handle signature in direct fields', () => {
      const ethersTx = createMockEthersTransaction({
        signature: undefined,
        index: 0,
        v: '27',
        r: '0xr123',
        s: '0xs456',
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(result.transactionIndex).toBe(0);
      expect(result.v).toBe('27');
      expect(result.r).toBe('0xr123');
      expect(result.s).toBe('0xs456');
    });

    it('should handle very large BigInt values', () => {
      const ethersTx = createMockEthersTransaction({
        value: BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935'),
        gasLimit: 30000000n,
        gasPrice: BigInt('1000000000000000000000'),
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(result.value).toBe('115792089237316195423570985008687907853269984665640564039457584007913129639935');
      expect(result.gasPrice).toBe('1000000000000000000000');
      expect(result.gas).toBe(30000000);
    });

    it('should handle undefined and null values gracefully', () => {
      const ethersTx = createMockEthersTransaction({
        to: null,
        value: undefined,
        data: undefined,
        type: undefined,
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(result.to).toBeNull();
      expect(result.value).toBe('0');
      expect(result.input).toBe('0x');
      expect(result.type).toBe('0');
    });
  });

  describe('normalizeReceipt', () => {
    it('should normalize transaction receipt with BigInt values', () => {
      const ethersReceipt = createMockEthersReceipt();
      const result = provider['normalizeReceipt'](ethersReceipt);

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
      const ethersReceipt = createMockEthersReceipt({
        status: 0,
        type: 0,
        effectiveGasPrice: 20000000000n,
        blobGasUsed: undefined,
        blobGasPrice: undefined,
      });

      const result = provider['normalizeReceipt'](ethersReceipt);
      expect(result.status).toBe('0x0');
    });

    it('should normalize logs in receipt', () => {
      const mockLog = createMockLog();
      const ethersReceipt = createMockEthersReceipt({
        logs: [mockLog],
      });

      const result = provider['normalizeReceipt'](ethersReceipt);

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

    it('should handle alternative field names', () => {
      const ethersReceipt = createMockEthersReceipt({
        hash: '0xtx123',
        index: 0,
        transactionHash: undefined,
        transactionIndex: undefined,
      });

      const result = provider['normalizeReceipt'](ethersReceipt);

      expect(result.transactionHash).toBe('0xtx123');
      expect(result.transactionIndex).toBe(0);
    });

    it('should handle missing blob fields', () => {
      const ethersReceipt = createMockEthersReceipt({
        blobGasUsed: undefined,
        blobGasPrice: undefined,
      });

      const result = provider['normalizeReceipt'](ethersReceipt);

      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle access list in transactions', () => {
      const accessList = [
        { address: '0xcontract1', storageKeys: ['0xkey1', '0xkey2'] },
        { address: '0xcontract2', storageKeys: ['0xkey3'] },
      ];

      const ethersTx = createMockEthersTransaction({
        type: 1,
        accessList,
      });

      const result = provider['normalizeTransaction'](ethersTx);
      expect(result.accessList).toEqual(accessList);
    });

    it('should handle maximum gas values', () => {
      const ethersTx = createMockEthersTransaction({
        gasLimit: BigInt('0xffffffffffffffff'), // Max uint64
        gasPrice: BigInt('0xffffffffffffffff'),
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(typeof result.gas).toBe('number');
      expect(typeof result.gasPrice).toBe('string');
    });

    it('should handle zero values correctly', () => {
      const ethersTx = createMockEthersTransaction({
        nonce: 0,
        value: 0n,
        gasPrice: 0n,
        chainId: 0n,
      });

      const result = provider['normalizeTransaction'](ethersTx);

      expect(result.nonce).toBe(0);
      expect(result.value).toBe('0');
      expect(result.gasPrice).toBe('0');
      expect(result.chainId).toBeUndefined();
    });

    it('should handle complex log structure', () => {
      const complexLog = createMockLog({
        topics: ['0xtopic1', '0xtopic2', '0xtopic3', '0xtopic4'],
        data: '0x' + 'a'.repeat(128), // 64 bytes of data
        logIndex: 5,
        removed: true,
      });

      const ethersReceipt = createMockEthersReceipt({
        logs: [complexLog],
      });

      const result = provider['normalizeReceipt'](ethersReceipt);

      expect(result.logs[0]!.topics).toHaveLength(4);
      expect(result.logs[0]!.logIndex).toBe(5);
      expect(result.logs[0]!.removed).toBe(true);
    });
  });
});