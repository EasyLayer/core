import { EvmTrieVerifier } from '../trie-verifier';

describe('EvmTrieVerifier', () => {
  it('returns canonical empty trie root for empty tx and receipt lists', async () => {
    await expect(EvmTrieVerifier.computeTransactionsRoot([])).resolves.toBe(EvmTrieVerifier.getEmptyTrieRoot());
    await expect(EvmTrieVerifier.computeReceiptsRoot([])).resolves.toBe(EvmTrieVerifier.getEmptyTrieRoot());
  });

  it('verifies legacy transaction roots from full tx objects', async () => {
    const transactions = [
      {
        nonce: '0x1',
        gasPrice: '0x3b9aca00',
        gas: '0x5208',
        to: `0x${'a'.repeat(40)}`,
        value: '0x0',
        input: '0x',
        v: '0x1b',
        r: '0x1',
        s: '0x2',
      },
    ];

    const root = await EvmTrieVerifier.computeTransactionsRoot(transactions);
    await expect(EvmTrieVerifier.verifyTransactionsRoot(transactions, root)).resolves.toBe(true);
  });

  it('verifies typed transaction and receipt roots', async () => {
    const transactions = [
      {
        type: '0x2',
        chainId: '0x1',
        nonce: '0x1',
        maxPriorityFeePerGas: '0x59682f00',
        maxFeePerGas: '0x59682f10',
        gas: '0x5208',
        to: `0x${'b'.repeat(40)}`,
        value: '0x0',
        input: '0x',
        accessList: [],
        yParity: '0x1',
        r: '0x3',
        s: '0x4',
      },
    ];
    const receipts = [
      {
        type: '0x2',
        status: '0x1',
        cumulativeGasUsed: '0x5208',
        logsBloom: '0x',
        logs: [],
      },
    ];

    const txRoot = await EvmTrieVerifier.computeTransactionsRoot(transactions);
    const receiptRoot = await EvmTrieVerifier.computeReceiptsRoot(receipts);

    await expect(EvmTrieVerifier.verifyTransactionsRoot(transactions, txRoot)).resolves.toBe(true);
    await expect(EvmTrieVerifier.verifyReceiptsRoot(receipts, receiptRoot)).resolves.toBe(true);
  });
});
