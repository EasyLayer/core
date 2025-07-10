import { Block, Transaction, TransactionReceipt, Log, Withdrawal } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';

/**
 * Helper function to create an EVM log entry.
 */
function createEvmLog(logIndex: number, blockNumber: number, transactionHash: string): Log {
  return {
    address: `0x${'contract' + logIndex.toString().padStart(32, '0')}`,
    topics: [
      `0x${'topic0' + logIndex.toString().padStart(58, '0')}`, // Event signature
      `0x${'topic1' + logIndex.toString().padStart(58, '0')}`, // Indexed parameter 1
    ],
    data: `0x${'data' + logIndex.toString().padStart(60, '0')}`,
    blockNumber,
    transactionHash,
    transactionIndex: 0,
    blockHash: `0x${'block' + blockNumber.toString().padStart(59, '0')}`,
    logIndex,
    removed: false
  };
}

/**
 * Helper function to create an EVM transaction receipt.
 */
function createEvmReceipt(transactionHash: string, blockNumber: number, gasUsed: number): TransactionReceipt {
  return {
    transactionHash,
    transactionIndex: 0,
    blockHash: `0x${'block' + blockNumber.toString().padStart(59, '0')}`,
    blockNumber,
    from: `0x${'from' + '0'.repeat(36)}`,
    to: `0x${'to' + '0'.repeat(38)}`,
    cumulativeGasUsed: gasUsed,
    gasUsed,
    contractAddress: null,
    logs: [createEvmLog(0, blockNumber, transactionHash)],
    logsBloom: '0x' + '0'.repeat(512),
    status: '0x1',
    type: '0x0',
    effectiveGasPrice: 20000000000 // 20 Gwei
  };
}

/**
 * Helper function to create an EVM transaction with all required properties.
 */
function createEvmTransaction(nonce: number, gasUsed: number = 21000, txType: string = '0x0'): Transaction {
  const hash = `0x${'tx' + nonce.toString().padStart(62, '0')}`;
  
  const baseTx: Transaction = {
    hash,
    blockHash: `0x${'block' + '0'.repeat(60)}`,
    blockNumber: 0, // Will be overridden when added to block
    transactionIndex: nonce,
    from: `0x${'from' + nonce.toString().padStart(36, '0')}`,
    to: `0x${'to' + nonce.toString().padStart(38, '0')}`,
    value: '1000000000000000000', // 1 ETH in wei
    gas: gasUsed,
    input: '0x',
    nonce: nonce,
    chainId: 1, // Ethereum mainnet
    v: '0x1c',
    r: `0x${'r' + nonce.toString().padStart(62, '0')}`,
    s: `0x${'s' + nonce.toString().padStart(62, '0')}`,
    type: txType
  };

  // Add type-specific fields
  if (txType === '0x0') {
    // Legacy transaction
    baseTx.gasPrice = '20000000000'; // 20 Gwei
  } else if (txType === '0x2') {
    // EIP-1559 transaction
    baseTx.maxFeePerGas = '30000000000'; // 30 Gwei
    baseTx.maxPriorityFeePerGas = '2000000000'; // 2 Gwei
  }

  return baseTx;
}

/**
 * Helper function to create an EVM block with all required properties.
 */
function createEvmBlock(
  blockNumber: number, 
  transactions: Transaction[] = [], 
  blockSize: number = 15000,
  options: {
    withReceipts?: boolean;
    withWithdrawals?: boolean;
    withBlobFields?: boolean;
    baseFeePerGas?: string;
  } = {}
): Block {
  const timestamp = Math.floor(Date.now() / 1000);
  const blockHash = `0x${'block' + blockNumber.toString().padStart(59, '0')}`;
  
  // Update transactions with correct block info
  const updatedTransactions = transactions.map((tx, index) => ({
    ...tx,
    blockNumber,
    blockHash,
    transactionIndex: index
  }));

  const block: Block = {
    blockNumber,
    hash: blockHash,
    parentHash: blockNumber > 0 
      ? `0x${'block' + (blockNumber - 1).toString().padStart(59, '0')}` 
      : '0x0000000000000000000000000000000000000000000000000000000000000000',
    nonce: `0x${'0'.repeat(8)}${blockNumber.toString(16).padStart(8, '0')}`,
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x' + '0'.repeat(512),
    transactionsRoot: `0x${'txroot' + blockNumber.toString().padStart(57, '0')}`,
    stateRoot: `0x${'state' + blockNumber.toString().padStart(59, '0')}`,
    receiptsRoot: `0x${'receipts' + blockNumber.toString().padStart(55, '0')}`,
    miner: `0x${'miner' + blockNumber.toString().padStart(35, '0')}`,
    difficulty: (1000000 + blockNumber * 1000).toString(),
    totalDifficulty: (2000000 + blockNumber * 2000).toString(),
    extraData: '0x',
    size: blockSize,
    sizeWithoutReceipts: Math.floor(blockSize * 0.7), // Receipts ~30% of block size
    gasLimit: 30000000, // Current Ethereum gas limit
    gasUsed: updatedTransactions.reduce((sum, tx) => sum + tx.gas, 0),
    timestamp,
    uncles: [],
    transactions: updatedTransactions
  };

  // Add optional fields based on options
  if (options.baseFeePerGas) {
    block.baseFeePerGas = options.baseFeePerGas;
  }

  if (options.withReceipts) {
    block.receipts = updatedTransactions.map(tx => 
      createEvmReceipt(tx.hash, blockNumber, tx.gas)
    );
  }

  if (options.withWithdrawals) {
    block.withdrawals = [
      {
        index: '0x1',
        validatorIndex: '0x100',
        address: `0x${'validator' + blockNumber.toString().padStart(30, '0')}`,
        amount: '32000000000000000000' // 32 ETH in wei
      }
    ];
    block.withdrawalsRoot = `0x${'withdrawals' + blockNumber.toString().padStart(53, '0')}`;
  }

  if (options.withBlobFields) {
    block.blobGasUsed = '131072'; // 128KB blob gas
    block.excessBlobGas = '0';
    block.parentBeaconBlockRoot = `0x${'beacon' + blockNumber.toString().padStart(58, '0')}`;
  }

  return block;
}

describe('EVM BlocksQueue', () => {
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 50000, // 50KB default block size for Ethereum
      maxQueueSize: 10 * 1024 * 1024 // 10MB queue
    });
  });

  describe('Initialization', () => {
    it('should initialize with an empty queue', () => {
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should initialize with correct block size for Ethereum', () => {
      expect(queue.blockSize).toBe(50000);
    });
  });

  describe('Enqueue Operation', () => {
    it('should enqueue a basic block with legacy transactions', async () => {
      const transactions = [
        createEvmTransaction(0, 21000, '0x0'), // Legacy ETH transfer
        createEvmTransaction(1, 50000, '0x0')  // Legacy contract call
      ];
      const block = createEvmBlock(0, transactions, 15000);
      
      await queue.enqueue(block);

      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(0);
      expect(queue.currentSize).toBe(15000);
      expect(block.gasUsed).toBe(71000); // 21000 + 50000
      expect(block.transactions).toHaveLength(2);
      expect(block.transactions![0]!.type).toBe('0x0');
      expect(block.transactions![0]!.gasPrice).toBeDefined();
    });

    it('should enqueue a block with EIP-1559 transactions', async () => {
      const transactions = [
        createEvmTransaction(0, 21000, '0x2'), // EIP-1559 ETH transfer
        createEvmTransaction(1, 100000, '0x2') // EIP-1559 DeFi transaction
      ];
      const block = createEvmBlock(0, transactions, 20000, { 
        baseFeePerGas: '15000000000' // 15 Gwei base fee
      });
      
      await queue.enqueue(block);

      expect(queue.length).toBe(1);
      expect(block.baseFeePerGas).toBe('15000000000');
      expect(block.transactions![0]!.type).toBe('0x2');
      expect(block.transactions![0]!.maxFeePerGas).toBeDefined();
      expect(block.transactions![0]!.maxPriorityFeePerGas).toBeDefined();
      expect(block.transactions![0]!.gasPrice).toBeUndefined();
    });

    it('should throw error when block number is not sequential', async () => {
      const block = createEvmBlock(1); // Should be 0
      
      await expect(queue.enqueue(block)).rejects.toThrow(
        'Can\'t enqueue block. Block height: 1, Queue last height: -1'
      );
    });

    it('should enqueue multiple blocks in sequence', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [
        createEvmTransaction(1), 
        createEvmTransaction(2)
      ], 15000);
      const block2 = createEvmBlock(2, [], 8000); // Empty block

      await queue.enqueue(block0);
      await queue.enqueue(block1);
      await queue.enqueue(block2);

      expect(queue.length).toBe(3);
      expect(queue.lastHeight).toBe(2);
      expect(queue.currentSize).toBe(33000); // 10000 + 15000 + 8000
    });

    it('should handle blocks with transaction receipts', async () => {
      const transactions = [createEvmTransaction(0, 21000)];
      const block = createEvmBlock(0, transactions, 12000, { withReceipts: true });
      
      await queue.enqueue(block);

      expect(block.receipts).toBeDefined();
      expect(block.receipts).toHaveLength(1);
      expect(block.receipts![0]!.status).toBe('0x1');
      expect(block.receipts![0]!.gasUsed).toBe(21000);
      expect(block.receipts![0]!.logs).toHaveLength(1);
    });

    it('should handle blocks with withdrawals (Shanghai fork)', async () => {
      const block = createEvmBlock(0, [], 15000, { withWithdrawals: true });
      
      await queue.enqueue(block);

      expect(block.withdrawals).toBeDefined();
      expect(block.withdrawals).toHaveLength(1);
      expect(block.withdrawals![0]!.amount).toBe('32000000000000000000');
      expect(block.withdrawalsRoot).toBeDefined();
    });

    it('should handle blocks with blob fields (Dencun fork)', async () => {
      const block = createEvmBlock(0, [], 18000, { withBlobFields: true });
      
      await queue.enqueue(block);

      expect(block.blobGasUsed).toBe('131072');
      expect(block.excessBlobGas).toBe('0');
      expect(block.parentBeaconBlockRoot).toBeDefined();
    });

    it('should throw error when max height is reached', async () => {
      queue.maxBlockHeight = 1;
      
      const block0 = createEvmBlock(0);
      const block1 = createEvmBlock(1);
      
      await queue.enqueue(block0);
      await queue.enqueue(block1);

      const block2 = createEvmBlock(2);
      await expect(queue.enqueue(block2)).rejects.toThrow(
        /isMaxHeightReached: true/
      );
    });
  });

  describe('Dequeue Operation', () => {
    it('should dequeue blocks correctly', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);

      await queue.enqueue(block0);
      await queue.enqueue(block1);

      // Trigger transferItems
      await queue.firstBlock();

      const dequeuedBlock = await queue.dequeue(block0.hash) as Block;
      
      expect(dequeuedBlock.blockNumber).toBe(0);
      expect(dequeuedBlock.hash).toBe(block0.hash);
      expect(queue.length).toBe(1);
      expect(queue.currentSize).toBe(12000);
    });

    it('should throw error when dequeuing unknown block', async () => {
      await expect(queue.dequeue('0x123')).rejects.toThrow(
        'Block not found or hash mismatch: 0x123'
      );
    });
  });

  describe('Block Retrieval', () => {
    it('should return undefined for firstBlock when queue is empty', async () => {
      const first = await queue.firstBlock();
      expect(first).toBeUndefined();
    });

    it('should return first block when queue has blocks', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);
      
      await queue.enqueue(block0);
      await queue.enqueue(block1);
      
      const first = await queue.firstBlock();
      expect(first?.blockNumber).toBe(0);
    });

    it('should find block by height from inStack', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);
      
      await queue.enqueue(block0);
      await queue.enqueue(block1);
      
      const found = queue.fetchBlockFromInStack(1);
      expect(found?.blockNumber).toBe(1);
      
      const notFound = queue.fetchBlockFromInStack(999);
      expect(notFound).toBeUndefined();
    });

    it('should find block by height from outStack', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      await queue.enqueue(block0);
      
      // Trigger transferItems
      await queue.firstBlock();
      
      const found = await queue.fetchBlockFromOutStack(0);
      expect(found?.blockNumber).toBe(0);
    });
  });

  describe('Batch Operations', () => {
    it('should return correct batch up to size limit', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 8000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 9000);
      const block2 = createEvmBlock(2, [createEvmTransaction(2)], 10000);

      await queue.enqueue(block0);
      await queue.enqueue(block1);
      await queue.enqueue(block2);

      // Trigger transferItems
      await queue.firstBlock();

      const batch = await queue.getBatchUpToSize(18000); // Should fit first 2 blocks
      
      expect(batch.length).toBe(2);
      expect(batch[0].blockNumber).toBe(0);
      expect(batch[1].blockNumber).toBe(1);
    });

    it('should return at least one block even if it exceeds maxSize', async () => {
      const largeBlock = createEvmBlock(0, [createEvmTransaction(0)], 25000);
      await queue.enqueue(largeBlock);
      
      await queue.firstBlock();
      
      const batch = await queue.getBatchUpToSize(10000); // Smaller than block size
      
      expect(batch.length).toBe(1);
      expect(batch[0].size).toBe(25000);
    });

    it('should find blocks by hash correctly', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);
      const block2 = createEvmBlock(2, [createEvmTransaction(2)], 14000);

      await queue.enqueue(block0);
      await queue.enqueue(block1);
      await queue.enqueue(block2);

      await queue.firstBlock();

      const foundBlocks = await queue.findBlocks(new Set([block0.hash, block2.hash]));
      
      expect(foundBlocks).toHaveLength(2);
      expect(foundBlocks.map(b => b.blockNumber).sort()).toEqual([0, 2]);
    });
  });

  describe('Queue Management', () => {
    it('should clear queue correctly', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);

      await queue.enqueue(block0);
      await queue.enqueue(block1);

      queue.clear();

      expect(queue.length).toBe(0);
      expect(queue.currentSize).toBe(0);
      expect(queue.lastHeight).toBe(1); // Last height preserved
    });

    it('should reorganize queue correctly', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);

      await queue.enqueue(block0);
      await queue.enqueue(block1);

      await queue.reorganize(0);

      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(0);
      expect(queue.currentSize).toBe(0);
    });

    it('should handle queue overload detection', () => {
      expect(queue.isQueueOverloaded(5 * 1024 * 1024)).toBe(false); // 5MB additional
      expect(queue.isQueueOverloaded(15 * 1024 * 1024)).toBe(true); // 15MB additional (exceeds 10MB limit)
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty blocks correctly', async () => {
      const emptyBlock = createEvmBlock(0, [], 8000);
      
      await queue.enqueue(emptyBlock);
      
      expect(queue.length).toBe(1);
      expect(emptyBlock.transactions).toHaveLength(0);
      expect(emptyBlock.gasUsed).toBe(0);
    });

    it('should handle blocks with complex transaction types', async () => {
      const transactions = [
        createEvmTransaction(0, 21000, '0x0'),  // Legacy
        createEvmTransaction(1, 50000, '0x2'),  // EIP-1559
      ];
      const block = createEvmBlock(0, transactions, 18000);
      
      await queue.enqueue(block);
      
      expect(block.transactions![0]!.type).toBe('0x0');
      expect(block.transactions![1]!.type).toBe('0x2');
      expect(block.transactions![0]!.gasPrice).toBeDefined();
      expect(block.transactions![1]!.maxFeePerGas).toBeDefined();
    });

    it('should handle very large block numbers', async () => {
      const largeNumberQueue = new BlocksQueue<Block>({
        lastHeight: Number.MAX_SAFE_INTEGER - 1,
        maxQueueSize: 10 * 1024 * 1024,
        blockSize: 50000,
        maxBlockHeight: Number.MAX_SAFE_INTEGER
      });
      
      const block = createEvmBlock(Number.MAX_SAFE_INTEGER, [], 10000);
      
      await largeNumberQueue.enqueue(block);
      
      expect(largeNumberQueue.lastHeight).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle concurrent enqueue operations', async () => {
      const block0 = createEvmBlock(0, [createEvmTransaction(0)], 10000);
      const block1 = createEvmBlock(1, [createEvmTransaction(1)], 12000);
      
      // These should be executed sequentially due to mutex
      const promises = [
        queue.enqueue(block0),
        queue.enqueue(block1)
      ];
      
      await Promise.all(promises);
      
      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(1);
    });
  });
});