import { Blockchain } from '../blockchain.structure';
import { LightBlock } from '../block.interfaces';

describe('EVM Blockchain', () => {
  let blockchain: Blockchain;

  beforeEach(() => {
    // Initialize a new Blockchain instance with a maxSize of 5 for testing
    blockchain = new Blockchain({ maxSize: 5 });
  });

  // Real EVM blocks data (Ethereum-like structure)
  const getRealEvmBlocks = () => {
    return {
      // Genesis block (block 0)
      genesis: {
        blockNumber: 0,
        hash: '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
        parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
        transactions: [],
        receipts: []
      },
      // Block 1
      block1: {
        blockNumber: 1,
        hash: '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6',
        parentHash: '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
        transactionsRoot: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        receiptsRoot: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
        stateRoot: '0x3c837e61e9b8f78f12d65d5b5b5e8c7e8f7f8a8a8b8c8d8e8f9fa9fb9fc9fd9f',
        transactions: ['0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'],
        receipts: ['0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890']
      },
      // Block 2
      block2: {
        blockNumber: 2,
        hash: '0x3d6122660cc824376f11ee842f83addc3525e2dd6756b9bcf0affa6aa88cf741',
        parentHash: '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6',
        transactionsRoot: '0x2dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49348',
        receiptsRoot: '0x2dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49348',
        stateRoot: '0x4c837e61e9b8f78f12d65d5b5b5e8c7e8f7f8a8a8b8c8d8e8f9fa9fb9fc9fd9f',
        transactions: ['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'],
        receipts: ['0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef']
      }
    };
  };

  describe('addBlock and addBlocks', () => {
    it('should add a single EVM block successfully', () => {
      const realBlocks = getRealEvmBlocks();
      const result = blockchain.addBlock(realBlocks.genesis);
      
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.head).toBe(blockchain.tail);
      expect(blockchain.lastBlockHeight).toBe(0);
    });

    it('should add multiple real EVM blocks successfully', () => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);
      expect(blockchain.lastBlockHeight).toBe(2);
      expect(blockchain.head?.block.hash).toBe(realBlocks.genesis.hash);
      expect(blockchain.tail?.block.hash).toBe(realBlocks.block2.hash);
    });

    it('should add a block with non-zero starting height successfully', () => {
      const realBlocks = getRealEvmBlocks();
      // Start from block 1 (non-genesis)
      const result = blockchain.addBlock(realBlocks.block1);
      
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.head).toBe(blockchain.tail);
      expect(blockchain.lastBlockHeight).toBe(1);
    });

    it('should not add a block with invalid sequence', () => {
      const realBlocks = getRealEvmBlocks();
      
      // Create invalid sequence by skipping block 1
      const invalidBlock: LightBlock = {
        ...realBlocks.block2,
        parentHash: realBlocks.genesis.hash // Wrong: should connect to block1
      };
      
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        invalidBlock // This should fail validation
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(false);
      expect(blockchain.size).toBe(0);
    });

    it('should not add blocks with invalid sequence in multiple additions', () => {
      const realBlocks = getRealEvmBlocks();
      
      // Add first block successfully
      const result1 = blockchain.addBlock(realBlocks.genesis);
      expect(result1).toBe(true);
      expect(blockchain.size).toBe(1);

      // Try to add block 2 directly (skipping block 1)
      const invalidBlock: LightBlock = {
        ...realBlocks.block2,
        parentHash: realBlocks.genesis.hash
      };

      const result2 = blockchain.addBlock(invalidBlock);
      expect(result2).toBe(false);
      expect(blockchain.size).toBe(1); // Size should remain unchanged
    });
  });

  describe('truncateToBlock', () => {
    beforeEach(() => {
      // Add real EVM blocks and some test blocks
      const realBlocks = getRealEvmBlocks();
      
      const testBlocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2,
        // Additional test blocks
        {
          blockNumber: 3,
          hash: '0x4d6122660cc824376f11ee842f83addc3525e2dd6756b9bcf0affa6aa88cf742',
          parentHash: realBlocks.block2.hash,
          transactionsRoot: '0x3dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49349',
          receiptsRoot: '0x3dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49349',
          stateRoot: '0x5c837e61e9b8f78f12d65d5b5b5e8c7e8f7f8a8a8b8c8d8e8f9fa9fb9fc9fd9f',
          transactions: ['0x3456789012345678901234567890123456789012345678901234567890123456'],
          receipts: ['0x3456789012345678901234567890123456789012345678901234567890123456']
        },
        {
          blockNumber: 4,
          hash: '0x5d6122660cc824376f11ee842f83addc3525e2dd6756b9bcf0affa6aa88cf743',
          parentHash: '0x4d6122660cc824376f11ee842f83addc3525e2dd6756b9bcf0affa6aa88cf742',
          transactionsRoot: '0x4dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49350',
          receiptsRoot: '0x4dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49350',
          stateRoot: '0x6c837e61e9b8f78f12d65d5b5b5e8c7e8f7f8a8a8b8c8d8e8f9fa9fb9fc9fd9f',
          transactions: ['0x4567890123456789012345678901234567890123456789012345678901234567'],
          receipts: ['0x4567890123456789012345678901234567890123456789012345678901234567']
        }
      ];

      const result = blockchain.addBlocks(testBlocks);
      expect(result).toBe(true); // Sanity check that setup works
    });

    it('should truncate the chain to a valid existing height', () => {
      const truncateHeight = 2;
      const result = blockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);
      expect(blockchain.lastBlockHeight).toBe(truncateHeight);
      expect(blockchain.tail?.block.hash).toBe('0x3d6122660cc824376f11ee842f83addc3525e2dd6756b9bcf0affa6aa88cf741');
    });

    it('should not truncate the chain if the height is less than -1', () => {
      const truncateHeight = -2; // Invalid height
      const result = blockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(false);
      expect(blockchain.size).toBe(5); // No change
    });

    it('should truncate the entire chain when height is -1', () => {
      const truncateHeight = -1; // Clear the chain
      const result = blockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(0);
      expect(blockchain.head).toBeNull();
      expect(blockchain.tail).toBeNull();
      expect(blockchain.lastBlockHeight).toBeUndefined();
    });

    it('should not truncate the chain if height is greater than the last block height', () => {
      const truncateHeight = 10; // Height does not exist and is greater than last block's height
      const result = blockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(false);
      expect(blockchain.size).toBe(5); // No change
      expect(blockchain.lastBlockHeight).toBe(4);
    });

    it('should truncate the chain to result in a size of 1', () => {
      const truncateHeight = 0;
      const result = blockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.lastBlockHeight).toBe(0);
      expect(blockchain.head?.block.hash).toBe('0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3');
      expect(blockchain.tail?.block.hash).toBe('0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3');
    });

    it('should handle truncating an already empty chain gracefully', () => {
      // Clear the chain first
      blockchain.truncateToBlock(-1);
      expect(blockchain.size).toBe(0);

      // Attempt to truncate again
      const result = blockchain.truncateToBlock(-1);
      expect(result).toBe(true); // Should return true as the chain is already empty
      expect(blockchain.size).toBe(0);
      expect(blockchain.head).toBeNull();
      expect(blockchain.tail).toBeNull();
      expect(blockchain.lastBlockHeight).toBeUndefined();
    });
  });

  describe('validateChain', () => {
    it('should validate a correct chain with real EVM blocks', () => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.validateChain()).toBe(true);
    });

    it('should invalidate a chain with incorrect heights', () => {
      const realBlocks = getRealEvmBlocks();
      
      const block1 = realBlocks.genesis;
      const block2: LightBlock = {
        ...realBlocks.block1,
        blockNumber: 2, // Incorrect height (should be 1)
        parentHash: realBlocks.genesis.hash
      };

      const result1 = blockchain.addBlock(block1);
      expect(result1).toBe(true);

      const result2 = blockchain.addBlock(block2);
      expect(result2).toBe(false); // Second block should not be added
      expect(blockchain.validateChain()).toBe(true); // Remaining chain is valid
    });

    it('should invalidate a chain with incorrect parent hash', () => {
      const realBlocks = getRealEvmBlocks();
      
      const block1 = realBlocks.genesis;
      const block2: LightBlock = {
        ...realBlocks.block1,
        parentHash: '0x1234567890123456789012345678901234567890123456789012345678901234' // Wrong hash
      };

      const result1 = blockchain.addBlock(block1);
      expect(result1).toBe(true);
      expect(blockchain.size).toBe(1);

      const result2 = blockchain.addBlock(block2);
      expect(result2).toBe(false); // Second block should not be added
      expect(blockchain.size).toBe(1); // Only first block exists
      expect(blockchain.validateChain()).toBe(true); // Remaining chain is valid
    });

    it('should validate an empty chain', () => {
      expect(blockchain.size).toBe(0);
      expect(blockchain.validateChain()).toBe(true); // An empty chain is considered valid
    });
  });

  describe('findBlockByHeight', () => {
    it('should find a block by its height', () => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);

      const foundBlock = blockchain.findBlockByHeight(1);
      expect(foundBlock).toBeDefined();
      expect(foundBlock?.hash).toBe(realBlocks.block1.hash);
    });

    it('should return null if the block is not found', () => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(2);

      const foundBlock = blockchain.findBlockByHeight(5);
      expect(foundBlock).toBeNull();
    });
  });

  describe('validateLastBlock', () => {
    it('should validate the last block correctly', () => {
      const realBlocks = getRealEvmBlocks();
      const result = blockchain.addBlock(realBlocks.genesis);
      expect(result).toBe(true);

      const isValid = blockchain.validateLastBlock(
        realBlocks.genesis.blockNumber,
        realBlocks.genesis.hash,
        realBlocks.genesis.parentHash
      );
      expect(isValid).toBe(true);
    });

    it('should return false for incorrect last block data', () => {
      const realBlocks = getRealEvmBlocks();
      const result = blockchain.addBlock(realBlocks.genesis);
      expect(result).toBe(true);

      const isValid = blockchain.validateLastBlock(
        1, // Wrong height
        realBlocks.genesis.hash,
        realBlocks.genesis.parentHash
      );
      expect(isValid).toBe(false);
    });

    it('should return true for empty chain', () => {
      const isValid = blockchain.validateLastBlock(0, 'any_hash', 'any_parent');
      expect(isValid).toBe(true);
    });
  });

  describe('getLastNBlocks', () => {
    beforeEach(() => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];
      blockchain.addBlocks(blocks);
    });

    it('should return the last N blocks in correct order', () => {
      const lastBlocks = blockchain.getLastNBlocks(2);
      expect(lastBlocks).toHaveLength(2);
      expect(lastBlocks[0]!.blockNumber).toBe(1);
      expect(lastBlocks[1]!.blockNumber).toBe(2);
    });

    it('should return all blocks if N is greater than chain size', () => {
      const lastBlocks = blockchain.getLastNBlocks(10);
      expect(lastBlocks).toHaveLength(3);
      expect(lastBlocks[0]!.blockNumber).toBe(0);
      expect(lastBlocks[1]!.blockNumber).toBe(1);
      expect(lastBlocks[2]!.blockNumber).toBe(2);
    });

    it('should return empty array for N <= 0', () => {
      const lastBlocks = blockchain.getLastNBlocks(0);
      expect(lastBlocks).toHaveLength(0);
    });
  });

  describe('toArray and fromArray', () => {
    it('should convert to array and restore from array correctly', () => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      // Add blocks
      blockchain.addBlocks(blocks);
      expect(blockchain.size).toBe(3);

      // Convert to array
      const blocksArray = blockchain.toArray();
      expect(blocksArray).toHaveLength(3);
      expect(blocksArray[0]!.blockNumber).toBe(0);
      expect(blocksArray[1]!.blockNumber).toBe(1);
      expect(blocksArray[2]!.blockNumber).toBe(2);

      // Create new blockchain and restore from array
      const newBlockchain = new Blockchain({ maxSize: 10 });
      newBlockchain.fromArray(blocksArray);

      expect(newBlockchain.size).toBe(3);
      expect(newBlockchain.head?.block.hash).toBe(realBlocks.genesis.hash);
      expect(newBlockchain.tail?.block.hash).toBe(realBlocks.block2.hash);
      expect(newBlockchain.validateChain()).toBe(true);
    });

    it('should handle maxSize limit when restoring from array', () => {
      const realBlocks = getRealEvmBlocks();
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      // Create blockchain with small maxSize
      const smallBlockchain = new Blockchain({ maxSize: 2 });
      smallBlockchain.fromArray(blocks);

      // Should only keep the last 2 blocks
      expect(smallBlockchain.size).toBe(2);
      expect(smallBlockchain.head?.block.blockNumber).toBe(1);
      expect(smallBlockchain.tail?.block.blockNumber).toBe(2);
    });
  });

  describe('maxSize handling', () => {
    it('should remove oldest blocks when maxSize is exceeded', () => {
      const smallBlockchain = new Blockchain({ maxSize: 2 });
      const realBlocks = getRealEvmBlocks();

      // Add more blocks than maxSize
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      const result = smallBlockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(smallBlockchain.size).toBe(2); // Should only keep 2 blocks
      expect(smallBlockchain.head?.block.blockNumber).toBe(1); // Genesis should be removed
      expect(smallBlockchain.tail?.block.blockNumber).toBe(2);
    });

    it('should maintain correct chain structure after removing oldest blocks', () => {
      const smallBlockchain = new Blockchain({ maxSize: 2 });
      const realBlocks = getRealEvmBlocks();

      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      smallBlockchain.addBlocks(blocks);
      expect(smallBlockchain.validateChain()).toBe(true);
      expect(smallBlockchain.findBlockByHeight(0)).toBeNull(); // Genesis removed
      expect(smallBlockchain.findBlockByHeight(1)).not.toBeNull(); // Block 1 exists
      expect(smallBlockchain.findBlockByHeight(2)).not.toBeNull(); // Block 2 exists
    });
  });

  describe('edge cases', () => {
    it('should handle blockchain starting from non-genesis block', () => {
      // Start from block 1000
      const highBlock: LightBlock = {
        blockNumber: 1000,
        hash: '0x1234567890123456789012345678901234567890123456789012345678901234',
        parentHash: '0x0987654321098765432109876543210987654321098765432109876543210987',
        transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
        stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
        transactions: [],
        receipts: []
      };

      const result = blockchain.addBlock(highBlock);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.lastBlockHeight).toBe(1000);
    });

    it('should handle adding single block multiple times (idempotency)', () => {
      const realBlocks = getRealEvmBlocks();
      
      // Add the same block twice - second should fail
      const result1 = blockchain.addBlock(realBlocks.genesis);
      expect(result1).toBe(true);
      expect(blockchain.size).toBe(1);

      const result2 = blockchain.addBlock(realBlocks.genesis);
      expect(result2).toBe(false); // Should fail because block 0 already exists
      expect(blockchain.size).toBe(1); // Size should remain the same
    });
  });
});