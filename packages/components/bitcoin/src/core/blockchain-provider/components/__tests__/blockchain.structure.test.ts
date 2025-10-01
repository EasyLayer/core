import { Blockchain } from '../blockchain.structure';
import { LightBlock } from '../block.interfaces';

describe('Blockchain', () => {
  let blockchain: Blockchain;

  beforeEach(() => {
    // Initialize a new Blockchain instance with a maxSize of 5 for testing
    blockchain = new Blockchain({ maxSize: 5 });
  });

  // Real Bitcoin blocks data
  const getRealBlocks = () => {
    return {
      // Genesis block (block 0)
      genesis: {
        height: 0,
        hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        previousblockhash: '',
        merkleroot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
        tx: ['4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b']
      },
      // Block 1
      block1: {
        height: 1,
        hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048',
        previousblockhash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        merkleroot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
        tx: ['0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098']
      },
      // Block 2
      block2: {
        height: 2,
        hash: '000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd',
        previousblockhash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048',
        merkleroot: '9b0fc92260312ce44e74ef369f5c66bbb85848f2eddd5a7a1cde251e54ccfdd5',
        tx: ['9b0fc92260312ce44e74ef369f5c66bbb85848f2eddd5a7a1cde251e54ccfdd5']
      }
    };
  };

  describe('addBlock and addBlocks', () => {
    it('should add a single block successfully', () => {
      const realBlocks = getRealBlocks();
      const result = blockchain.addBlock(realBlocks.genesis);
      
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.head).toBe(blockchain.tail);
      expect(blockchain.lastBlockHeight).toBe(0);
    });

    it('should add multiple real Bitcoin blocks successfully', () => {
      const realBlocks = getRealBlocks();
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
      const realBlocks = getRealBlocks();
      // Start from block 1 (non-genesis)
      const result = blockchain.addBlock(realBlocks.block1);
      
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.head).toBe(blockchain.tail);
      expect(blockchain.lastBlockHeight).toBe(1);
    });

    it('should not add a block with invalid sequence', () => {
      const realBlocks = getRealBlocks();
      
      // Create invalid sequence by skipping block 1
      const invalidBlock: LightBlock = {
        ...realBlocks.block2,
        previousblockhash: realBlocks.genesis.hash // Wrong: should connect to block1
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
      const realBlocks = getRealBlocks();
      
      // Add first block successfully
      const result1 = blockchain.addBlock(realBlocks.genesis);
      expect(result1).toBe(true);
      expect(blockchain.size).toBe(1);

      // Try to add block 2 directly (skipping block 1)
      const invalidBlock: LightBlock = {
        ...realBlocks.block2,
        previousblockhash: realBlocks.genesis.hash
      };

      const result2 = blockchain.addBlock(invalidBlock);
      expect(result2).toBe(false);
      expect(blockchain.size).toBe(1); // Size should remain unchanged
    });
  });

  describe('truncateToBlock', () => {
    beforeEach(() => {
      // Add real Bitcoin blocks and some test blocks
      const realBlocks = getRealBlocks();
      
      const testBlocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2,
        // Additional test blocks
        {
          height: 3,
          hash: 'test_hash_3',
          previousblockhash: realBlocks.block2.hash,
          merkleroot: '3333333333333333333333333333333333333333333333333333333333333333',
          tx: ['3333333333333333333333333333333333333333333333333333333333333333']
        },
        {
          height: 4,
          hash: 'test_hash_4',
          previousblockhash: 'test_hash_3',
          merkleroot: '4444444444444444444444444444444444444444444444444444444444444444',
          tx: ['4444444444444444444444444444444444444444444444444444444444444444']
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
      expect(blockchain.tail?.block.hash).toBe('000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd');
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
      expect(blockchain.head?.block.hash).toBe('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
      expect(blockchain.tail?.block.hash).toBe('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
    });

    it('should truncate a chain that starts from a non-genesis block', () => {
      // Initialize a new blockchain starting from block 1
      const newBlockchain = new Blockchain({ maxSize: 5 });
      const realBlocks = getRealBlocks();
      
      const blocks: LightBlock[] = [
        realBlocks.block1,
        realBlocks.block2,
        {
          height: 3,
          hash: 'test_hash_3',
          previousblockhash: realBlocks.block2.hash,
          merkleroot: '3333333333333333333333333333333333333333333333333333333333333333',
          tx: ['3333333333333333333333333333333333333333333333333333333333333333']
        }
      ];

      const result1 = newBlockchain.addBlocks(blocks);
      expect(result1).toBe(true);
      expect(newBlockchain.size).toBe(3);
      expect(newBlockchain.head?.block.hash).toBe(realBlocks.block1.hash);
      expect(newBlockchain.tail?.block.hash).toBe('test_hash_3');

      // Truncate to height 2
      const truncateHeight = 2;
      const result = newBlockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(newBlockchain.size).toBe(2);
      expect(newBlockchain.lastBlockHeight).toBe(2);
      expect(newBlockchain.tail?.block.hash).toBe(realBlocks.block2.hash);
      expect(newBlockchain.head?.block.hash).toBe(realBlocks.block1.hash);
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
    it('should validate a correct chain with real Bitcoin blocks', () => {
      const realBlocks = getRealBlocks();
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
      const realBlocks = getRealBlocks();
      
      const block1 = realBlocks.genesis;
      const block2: LightBlock = {
        ...realBlocks.block1,
        height: 2, // Incorrect height (should be 1)
        previousblockhash: realBlocks.genesis.hash
      };

      const result1 = blockchain.addBlock(block1);
      expect(result1).toBe(true);

      const result2 = blockchain.addBlock(block2);
      expect(result2).toBe(false); // Second block should not be added
      expect(blockchain.validateChain()).toBe(true); // Remaining chain is valid
    });

    it('should invalidate a chain with incorrect previous hash', () => {
      const realBlocks = getRealBlocks();
      
      const block1 = realBlocks.genesis;
      const block2: LightBlock = {
        ...realBlocks.block1,
        previousblockhash: 'wrong_hash_here_1234567890abcdef1234567890abcdef12345678'
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
      const realBlocks = getRealBlocks();
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
      const realBlocks = getRealBlocks();
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
      const realBlocks = getRealBlocks();
      const result = blockchain.addBlock(realBlocks.genesis);
      expect(result).toBe(true);

      const isValid = blockchain.validateLastBlock(
        realBlocks.genesis.height,
        realBlocks.genesis.hash,
        realBlocks.genesis.previousblockhash
      );
      expect(isValid).toBe(true);
    });

    it('should return false for incorrect last block data', () => {
      const realBlocks = getRealBlocks();
      const result = blockchain.addBlock(realBlocks.genesis);
      expect(result).toBe(true);

      const isValid = blockchain.validateLastBlock(
        1, // Wrong height
        realBlocks.genesis.hash,
        realBlocks.genesis.previousblockhash
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
      const realBlocks = getRealBlocks();
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
      expect(lastBlocks[0]!.height).toBe(1);
      expect(lastBlocks[1]!.height).toBe(2);
    });

    it('should return all blocks if N is greater than chain size', () => {
      const lastBlocks = blockchain.getLastNBlocks(10);
      expect(lastBlocks).toHaveLength(3);
      expect(lastBlocks[0]!.height).toBe(0);
      expect(lastBlocks[1]!.height).toBe(1);
      expect(lastBlocks[2]!.height).toBe(2);
    });

    it('should return empty array for N <= 0', () => {
      const lastBlocks = blockchain.getLastNBlocks(0);
      expect(lastBlocks).toHaveLength(0);
    });
  });

  describe('toArray and fromArray', () => {
    it('should convert to array and restore from array correctly', () => {
      const realBlocks = getRealBlocks();
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
      expect(blocksArray[0]!.height).toBe(0);
      expect(blocksArray[1]!.height).toBe(1);
      expect(blocksArray[2]!.height).toBe(2);

      // Create new blockchain and restore from array
      const newBlockchain = new Blockchain({ maxSize: 10 });
      newBlockchain.fromArray(blocksArray);

      expect(newBlockchain.size).toBe(3);
      expect(newBlockchain.head?.block.hash).toBe(realBlocks.genesis.hash);
      expect(newBlockchain.tail?.block.hash).toBe(realBlocks.block2.hash);
      expect(newBlockchain.validateChain()).toBe(true);
    });

    it('should handle maxSize limit when restoring from array', () => {
      const realBlocks = getRealBlocks();
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
      expect(smallBlockchain.head?.block.height).toBe(1);
      expect(smallBlockchain.tail?.block.height).toBe(2);
    });
  });

  describe('maxSize handling', () => {
    it('should remove oldest blocks when maxSize is exceeded', () => {
      const smallBlockchain = new Blockchain({ maxSize: 2 });
      const realBlocks = getRealBlocks();

      // Add more blocks than maxSize
      const blocks: LightBlock[] = [
        realBlocks.genesis,
        realBlocks.block1,
        realBlocks.block2
      ];

      const result = smallBlockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(smallBlockchain.size).toBe(2); // Should only keep 2 blocks
      expect(smallBlockchain.head?.block.height).toBe(1); // Genesis should be removed
      expect(smallBlockchain.tail?.block.height).toBe(2);
    });

    it('should maintain correct chain structure after removing oldest blocks', () => {
      const smallBlockchain = new Blockchain({ maxSize: 2 });
      const realBlocks = getRealBlocks();

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
      const realBlocks = getRealBlocks();
      
      // Start from block 100
      const highBlock: LightBlock = {
        height: 100,
        hash: '0000000000000000000000000000000000000000000000000000000000000100',
        previousblockhash: '0000000000000000000000000000000000000000000000000000000000000099',
        merkleroot: '1111111111111111111111111111111111111111111111111111111111111111',
        tx: ['1111111111111111111111111111111111111111111111111111111111111111']
      };

      const result = blockchain.addBlock(highBlock);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.lastBlockHeight).toBe(100);
    });

    it('should handle adding single block multiple times (idempotency)', () => {
      const realBlocks = getRealBlocks();
      
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