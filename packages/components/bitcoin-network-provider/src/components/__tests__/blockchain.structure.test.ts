import { Blockchain, LightBlock } from '../blockchain.structure';

describe('Blockchain', () => {
  let blockchain: Blockchain;

  beforeEach(() => {
    // Initialize a new Blockchain instance with a maxSize of 5 for testing
    blockchain = new Blockchain({ maxSize: 5 });
  });

  describe('addBlock and addBlocks', () => {
    it('should add a single block successfully', () => {
      const block: LightBlock = {
        height: 0,
        hash: 'hash0',
        previousblockhash: '',
        tx: ['tx0-1'],
      };

      const result = blockchain.addBlock(block.height, block.hash, block.previousblockhash, block.tx);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.head).toBe(blockchain.tail);
      expect(blockchain.lastBlockHeight).toBe(0);
    });

    it('should add multiple blocks successfully', () => {
      const blocks: LightBlock[] = [
        {
          height: 0,
          hash: 'hash0',
          previousblockhash: '',
          tx: ['tx0-1'],
        },
        {
          height: 1,
          hash: 'hash1',
          previousblockhash: 'hash0',
          tx: ['tx1-1'],
        },
        {
          height: 2,
          hash: 'hash2',
          previousblockhash: 'hash1',
          tx: ['tx2-1'],
        },
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);
      expect(blockchain.lastBlockHeight).toBe(2);
      expect(blockchain.head?.block.hash).toBe('hash0');
      expect(blockchain.tail?.block.hash).toBe('hash2');
    });

    it('should add a block with non-zero starting height successfully', () => {
      const block: LightBlock = {
        height: 5,
        hash: 'hash5',
        previousblockhash: 'hash4',
        tx: ['tx5-1'],
      };

      // Since the chain is empty, it should allow adding any block as the starting point
      const result = blockchain.addBlock(block.height, block.hash, block.previousblockhash, block.tx);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.head).toBe(blockchain.tail);
      expect(blockchain.lastBlockHeight).toBe(5);
    });

    it('should not add a block with invalid sequence', () => {
      const blocks: LightBlock[] = [
        {
          height: 0,
          hash: 'hash0',
          previousblockhash: '',
          tx: ['tx0-1'],
        },
        {
          height: 2, // Invalid height (should be 1)
          hash: 'hash2',
          previousblockhash: 'hash0',
          tx: ['tx2-1'],
        },
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(false);
      expect(blockchain.size).toBe(0);
    });

    it('should not add blocks with invalid sequence in multiple additions', () => {
      const blocks1: LightBlock[] = [
        {
          height: 5,
          hash: 'hash5',
          previousblockhash: 'hash4',
          tx: ['tx5-1'],
        },
      ];

      const blocks2: LightBlock[] = [
        {
          height: 6,
          hash: 'hash6',
          previousblockhash: 'hash5',
          tx: ['tx6-1'],
        },
        {
          height: 8, // Invalid height (should be 7)
          hash: 'hash8',
          previousblockhash: 'hash6',
          tx: ['tx8-1'],
        },
      ];

      const result1 = blockchain.addBlocks(blocks1);
      expect(result1).toBe(true);
      expect(blockchain.size).toBe(1);

      const result2 = blockchain.addBlocks(blocks2);
      expect(result2).toBe(false);
      expect(blockchain.size).toBe(1); // Size should remain unchanged
    });
  });

  describe('truncateToBlock', () => {
    beforeEach(() => {
      // Add multiple blocks to the blockchain for truncation tests
      const blocks: LightBlock[] = [
        {
          height: 0,
          hash: 'hash0',
          previousblockhash: '',
          tx: ['tx0-1'],
        },
        {
          height: 1,
          hash: 'hash1',
          previousblockhash: 'hash0',
          tx: ['tx1-1'],
        },
        {
          height: 2,
          hash: 'hash2',
          previousblockhash: 'hash1',
          tx: ['tx2-1'],
        },
        {
          height: 3,
          hash: 'hash3',
          previousblockhash: 'hash2',
          tx: ['tx3-1'],
        },
        {
          height: 4,
          hash: 'hash4',
          previousblockhash: 'hash3',
          tx: ['tx4-1'],
        },
      ];

      blockchain.addBlocks(blocks);
    });

    it('should truncate the chain to a valid existing height', () => {
      const truncateHeight = 2;
      const result = blockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);
      expect(blockchain.lastBlockHeight).toBe(truncateHeight);
      expect(blockchain.tail?.block.hash).toBe('hash2');
      expect(blockchain.head?.block.hash).toBe('hash0');
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
      expect(blockchain.head?.block.hash).toBe('hash0');
      expect(blockchain.tail?.block.hash).toBe('hash0');
    });

    it('should truncate a chain that starts from a non-genesis block', () => {
      // Initialize a new blockchain starting from height 2
      const newBlockchain = new Blockchain({ maxSize: 5 });
      const blocks: LightBlock[] = [
        {
          height: 2,
          hash: 'hash2',
          previousblockhash: 'hash1',
          tx: ['tx2-1'],
        },
        {
          height: 3,
          hash: 'hash3',
          previousblockhash: 'hash2',
          tx: ['tx3-1'],
        },
        {
          height: 4,
          hash: 'hash4',
          previousblockhash: 'hash3',
          tx: ['tx4-1'],
        },
      ];

      const result1 = newBlockchain.addBlocks(blocks);
      expect(result1).toBe(true);
      expect(newBlockchain.size).toBe(3);
      expect(newBlockchain.head?.block.hash).toBe('hash2');
      expect(newBlockchain.tail?.block.hash).toBe('hash4');

      // Truncate to height 3
      const truncateHeight = 3;
      const result = newBlockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(newBlockchain.size).toBe(2);
      expect(newBlockchain.lastBlockHeight).toBe(3);
      expect(newBlockchain.tail?.block.hash).toBe('hash3');
      expect(newBlockchain.head?.block.hash).toBe('hash2');
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
    it('should validate a correct chain', () => {
      const blocks: LightBlock[] = [
        {
          height: 5,
          hash: 'hash5',
          previousblockhash: 'hash4',
          tx: ['tx5-1'],
        },
        {
          height: 6,
          hash: 'hash6',
          previousblockhash: 'hash5',
          tx: ['tx6-1'],
        },
        {
          height: 7,
          hash: 'hash7',
          previousblockhash: 'hash6',
          tx: ['tx7-1'],
        },
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.validateChain()).toBe(true);
    });

    it('should invalidate a chain with incorrect heights', () => {
      const blocks: LightBlock[] = [
        {
          height: 5,
          hash: 'hash5',
          previousblockhash: 'hash4',
          tx: ['tx5-1'],
        },
        {
          height: 7, // Incorrect height (should be 6)
          hash: 'hash7',
          previousblockhash: 'hash5',
          tx: ['tx7-1'],
        },
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(false); // Second block should not be added
      expect(blockchain.validateChain()).toBe(true); // Remaining chain is valid
    });

    it('should invalidate a chain with incorrect previous hash', () => {
      const blocks: LightBlock[] = [
        {
          height: 5,
          hash: 'hash5',
          previousblockhash: 'hash4',
          tx: ['tx5-1'],
        },
        {
          height: 6,
          hash: 'hash6',
          previousblockhash: 'hash_wrong', // Incorrect previous hash
          tx: ['tx6-1'],
        },
      ];

      const result1 = blockchain.addBlock(blocks[0].height, blocks[0].hash, blocks[0].previousblockhash, blocks[0].tx);
      expect(result1).toBe(true);
      expect(blockchain.size).toBe(1);

      const result2 = blockchain.addBlock(blocks[1].height, blocks[1].hash, blocks[1].previousblockhash, blocks[1].tx);
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
      const blocks: LightBlock[] = [
        {
          height: 2,
          hash: 'hash2',
          previousblockhash: 'hash1',
          tx: ['tx2-1'],
        },
        {
          height: 3,
          hash: 'hash3',
          previousblockhash: 'hash2',
          tx: ['tx3-1'],
        },
        {
          height: 4,
          hash: 'hash4',
          previousblockhash: 'hash3',
          tx: ['tx4-1'],
        },
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);

      const foundBlock = blockchain.findBlockByHeight(3);
      expect(foundBlock).toBeDefined();
      expect(foundBlock?.hash).toBe('hash3');
    });

    it('should return null if the block is not found', () => {
      const blocks: LightBlock[] = [
        {
          height: 2,
          hash: 'hash2',
          previousblockhash: 'hash1',
          tx: ['tx2-1'],
        },
        {
          height: 3,
          hash: 'hash3',
          previousblockhash: 'hash2',
          tx: ['tx3-1'],
        },
      ];

      const result = blockchain.addBlocks(blocks);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(2);

      const foundBlock = blockchain.findBlockByHeight(5);
      expect(foundBlock).toBeNull();
    });
  });

  describe('truncateToBlock with non-genesis starting point', () => {
    it('should truncate correctly when the chain starts from a non-genesis block', () => {
      // Initialize a new blockchain starting from height 2
      const newBlockchain = new Blockchain({ maxSize: 5 });
      const blocks: LightBlock[] = [
        {
          height: 2,
          hash: 'hash2',
          previousblockhash: 'hash1',
          tx: ['tx2-1'],
        },
        {
          height: 3,
          hash: 'hash3',
          previousblockhash: 'hash2',
          tx: ['tx3-1'],
        },
        {
          height: 4,
          hash: 'hash4',
          previousblockhash: 'hash3',
          tx: ['tx4-1'],
        },
      ];

      const result1 = newBlockchain.addBlocks(blocks);
      expect(result1).toBe(true);
      expect(newBlockchain.size).toBe(3);
      expect(newBlockchain.head?.block.hash).toBe('hash2');
      expect(newBlockchain.tail?.block.hash).toBe('hash4');

      // Truncate to height 3
      const truncateHeight = 3;
      const result = newBlockchain.truncateToBlock(truncateHeight);
      expect(result).toBe(true);
      expect(newBlockchain.size).toBe(2);
      expect(newBlockchain.lastBlockHeight).toBe(3);
      expect(newBlockchain.tail?.block.hash).toBe('hash3');
      expect(newBlockchain.head?.block.hash).toBe('hash2');
    });
  });
});
