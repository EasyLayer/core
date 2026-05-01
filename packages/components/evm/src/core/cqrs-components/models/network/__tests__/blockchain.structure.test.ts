import { Blockchain } from '../blockchain.structure';
import type { LightBlock } from '../../../../blockchain-provider/components/block.interfaces';

// Real Ethereum mainnet block hashes
const ETH_BLOCKS: LightBlock[] = [
  {
    blockNumber: 19_000_000,
    hash: '0x0a53aee1982eed72aa4bd73ae74a17c04fa6b49c1498f5eb12da3c7b5d77c8d3',
    parentHash: '0x15d5bc3f7f50a83af7be38e3cfafd6db80f74ddcc5e1bba2551f2849a72b34bf',
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
    transactions: ['0x' + 'a'.repeat(64)],
    receipts: ['0x' + 'a'.repeat(64)],
  },
  {
    blockNumber: 19_000_001,
    hash: '0x1234000000000000000000000000000000000000000000000000000000000001',
    parentHash: '0x0a53aee1982eed72aa4bd73ae74a17c04fa6b49c1498f5eb12da3c7b5d77c8d3',
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0x' + 'b'.repeat(64),
    transactions: ['0x' + 'b'.repeat(64)],
    receipts: ['0x' + 'b'.repeat(64)],
  },
  {
    blockNumber: 19_000_002,
    hash: '0x2345000000000000000000000000000000000000000000000000000000000002',
    parentHash: '0x1234000000000000000000000000000000000000000000000000000000000001',
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0x' + 'c'.repeat(64),
    transactions: ['0x' + 'c'.repeat(64)],
    receipts: ['0x' + 'c'.repeat(64)],
  },
];

describe('Blockchain', () => {
  let blockchain: Blockchain;

  beforeEach(() => {
    blockchain = new Blockchain({ maxSize: 10 });
  });

  describe('addBlock()', () => {
    it('adds genesis-equivalent block successfully', () => {
      const result = blockchain.addBlock(ETH_BLOCKS[0]!);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(1);
      expect(blockchain.lastBlockHeight).toBe(19_000_000);
    });

    it('adds sequential blocks updating lastBlockHeight', () => {
      blockchain.addBlock(ETH_BLOCKS[0]!);
      blockchain.addBlock(ETH_BLOCKS[1]!);
      expect(blockchain.lastBlockHeight).toBe(19_000_001);
      expect(blockchain.size).toBe(2);
    });

    it('lastBlock returns most recently added block', () => {
      blockchain.addBlock(ETH_BLOCKS[0]!);
      blockchain.addBlock(ETH_BLOCKS[1]!);
      expect(blockchain.lastBlock?.hash).toBe(ETH_BLOCKS[1]!.hash);
    });
  });

  describe('addBlocks()', () => {
    it('adds multiple blocks in one call', () => {
      const result = blockchain.addBlocks(ETH_BLOCKS);
      expect(result).toBe(true);
      expect(blockchain.size).toBe(3);
      expect(blockchain.lastBlockHeight).toBe(19_000_002);
    });

    it('returns false for blocks with wrong parentHash sequence', () => {
      blockchain.addBlock(ETH_BLOCKS[0]!);
      const wrongBlock: LightBlock = { ...ETH_BLOCKS[2]!, parentHash: '0x' + 'f'.repeat(64) };
      const result = blockchain.addBlocks([wrongBlock]);
      expect(result).toBe(false);
    });
  });

  describe('validateNextBlocks()', () => {
    it('returns true for valid sequence', () => {
      blockchain.addBlock(ETH_BLOCKS[0]!);
      expect(blockchain.validateNextBlocks([ETH_BLOCKS[1]!])).toBe(true);
    });

    it('returns false when parentHash does not match', () => {
      blockchain.addBlock(ETH_BLOCKS[0]!);
      const bad = { ...ETH_BLOCKS[1]!, parentHash: '0x' + '0'.repeat(64) };
      expect(blockchain.validateNextBlocks([bad])).toBe(false);
    });
  });

  describe('findBlockByHeight()', () => {
    it('finds block by exact height', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      const b = blockchain.findBlockByHeight(19_000_001);
      expect(b?.hash).toBe(ETH_BLOCKS[1]!.hash);
    });

    it('returns null for non-existent height', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      expect(blockchain.findBlockByHeight(99_999_999)).toBeNull();
    });
  });

  describe('getLastNBlocks()', () => {
    it('returns last N blocks in correct order', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      const last2 = blockchain.getLastNBlocks(2);
      expect(last2).toHaveLength(2);
      // Highest blockNumber should be last
      expect(last2[last2.length - 1]!.blockNumber).toBe(19_000_002);
    });

    it('returns all blocks when N > size', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      const all = blockchain.getLastNBlocks(100);
      expect(all).toHaveLength(3);
    });
  });

  describe('truncateToBlock()', () => {
    it('truncates chain to specified height', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      blockchain.truncateToBlock(19_000_001);
      expect(blockchain.lastBlockHeight).toBe(19_000_001);
      expect(blockchain.findBlockByHeight(19_000_002)).toBeNull();
    });

    it('truncating to -1 clears chain', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      blockchain.truncateToBlock(-1);
      expect(blockchain.size).toBe(0);
    });
  });

  describe('toArray() / fromArray()', () => {
    it('round-trips correctly', () => {
      blockchain.addBlocks(ETH_BLOCKS);
      const arr = blockchain.toArray();
      expect(arr).toHaveLength(3);

      const restored = new Blockchain({ maxSize: 10 });
      restored.fromArray(arr);
      expect(restored.size).toBe(3);
      expect(restored.lastBlockHeight).toBe(19_000_002);
      expect(restored.findBlockByHeight(19_000_001)?.hash).toBe(ETH_BLOCKS[1]!.hash);
    });
  });

  describe('maxSize circular buffer', () => {
    it('evicts oldest blocks when maxSize exceeded', () => {
      const small = new Blockchain({ maxSize: 2 });
      ETH_BLOCKS.forEach((b) => small.addBlock(b));
      // Should not exceed 2 blocks
      expect(small.size).toBeLessThanOrEqual(2);
      // The oldest block should be gone
      expect(small.findBlockByHeight(19_000_000)).toBeNull();
      // The latest should still be there
      expect(small.findBlockByHeight(19_000_002)).not.toBeNull();
    });
  });
});
