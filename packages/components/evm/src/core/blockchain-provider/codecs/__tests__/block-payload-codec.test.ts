import { decodeEvmBlockPayload, encodeEvmBlockPayload } from '../block-payload-codec';
import type { Block } from '../../components/block.interfaces';

describe('EVM block payload codec', () => {
  const block: Block = {
    hash: '0x' + 'a'.repeat(64),
    parentHash: '0x' + 'b'.repeat(64),
    blockNumber: 1,
    transactionsRoot: '0x' + 'c'.repeat(64),
    stateRoot: '0x' + 'd'.repeat(64),
    miner: '0x' + 'e'.repeat(40),
    extraData: '0x',
    size: 100,
    sizeWithoutReceipts: 80,
    gasLimit: 30_000_000,
    gasUsed: 21_000,
    timestamp: 1_700_000_000,
    uncles: [],
    transactionHashes: ['0x' + '1'.repeat(64)],
    baseFeePerGas: '1000000000',
  };

  it('round-trips MessagePack payload preserving decimal and hex strings', () => {
    const bytes = encodeEvmBlockPayload(block);
    const decoded = decodeEvmBlockPayload(bytes);

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(decoded).toEqual(block);
  });

  it('keeps JSON payload as fallback for existing tests and browser fallback', () => {
    const bytes = Buffer.from(JSON.stringify(block), 'utf8');
    expect(decodeEvmBlockPayload(bytes)).toEqual(block);
  });
});
