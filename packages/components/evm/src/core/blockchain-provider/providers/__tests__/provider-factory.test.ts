import { createProvider } from '../provider-factory';
import { NodeProviderTypes } from '../interfaces';

const network = {
  chainId: 1,
  nativeCurrencySymbol: 'ETH',
  nativeCurrencyDecimals: 18,
  blockTime: 12,
  hasEIP1559: true,
  hasWithdrawals: true,
  hasBlobTransactions: true,
  maxBlockSize: 2_000_000,
  maxBlockWeight: 2_000_000,
  maxGasLimit: 36_000_000,
  maxTransactionSize: 128_000,
  minGasPrice: '0',
  maxCodeSize: 24_576,
  maxInitCodeSize: 49_152,
  supportsTraces: true,
  targetBlockTimeMs: 12_000,
} as const;

describe('createProvider', () => {
  it('creates EtherJS provider', () => {
    const provider = createProvider({
      type: NodeProviderTypes.ETHERJS,
      uniqName: 'etherjs-1',
      httpUrl: 'https://example.com',
      rateLimits: {},
      network: network as any,
    });

    expect(provider.type).toBe(NodeProviderTypes.ETHERJS);
  });

  it('creates Web3JS provider', () => {
    const provider = createProvider({
      type: NodeProviderTypes.WEB3JS,
      uniqName: 'web3js-1',
      httpUrl: 'https://example.com',
      rateLimits: {},
      network: network as any,
    });

    expect(provider.type).toBe(NodeProviderTypes.WEB3JS);
  });

  it('throws for unsupported provider type', () => {
    expect(() =>
      createProvider({
        type: 'unknown' as any,
        uniqName: 'bad-1',
        httpUrl: 'https://example.com',
        rateLimits: {},
        network: network as any,
      })
    ).toThrow('Unsupported provider type: unknown');
  });
});
