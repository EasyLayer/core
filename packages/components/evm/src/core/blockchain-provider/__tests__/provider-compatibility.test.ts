import { BlockchainProviderService } from '../blockchain-provider.service';
import type { NetworkConfig, UniversalBlock } from '../providers/interfaces';

const BASE_NETWORK: NetworkConfig = {
  chainId: 1,
  nativeCurrencySymbol: 'ETH',
  nativeCurrencyDecimals: 18,
  blockTime: 12,
  hasEIP1559: true,
  hasWithdrawals: false,
  hasBlobTransactions: false,
  maxBlockSize: 4_000_000,
  maxBlockWeight: 4_000_000,
  maxGasLimit: 30_000_000,
  maxTransactionSize: 131_072,
  minGasPrice: '1000000000',
  maxCodeSize: 24_576,
  maxInitCodeSize: 49_152,
  supportsTraces: false,
  targetBlockTimeMs: 12_000,
};

const block = (overrides: Partial<UniversalBlock> = {}): UniversalBlock => ({
  hash: '0x' + '1'.repeat(64),
  parentHash: '0x' + '0'.repeat(64),
  transactionsRoot: '0x' + '2'.repeat(64),
  stateRoot: '0x' + '3'.repeat(64),
  miner: '0x' + 'a'.repeat(40),
  extraData: '0x',
  size: 100,
  gasLimit: 30_000_000,
  gasUsed: 21_000,
  timestamp: 1_700_000_000,
  uncles: [],
  blockNumber: 100,
  transactions: [],
  ...overrides,
});

function serviceFor(network: NetworkConfig, provider: any, mempoolManager: any = { isAvailable: false, getActiveProvider: jest.fn() }) {
  const networkManager = {
    getActiveProvider: jest.fn().mockResolvedValue(provider),
    handleProviderFailure: jest.fn(),
  };

  return new BlockchainProviderService(networkManager as any, mempoolManager as any, network);
}

describe('BlockchainProviderService runtime compatibility', () => {
  it('accepts a provider that exposes the fields required by network config', async () => {
    const provider = {
      getBlockHeight: jest.fn().mockResolvedValue(100),
      getManyBlocksByHeights: jest.fn().mockResolvedValue([block({ baseFeePerGas: '0x3b9aca00' })]),
    };

    const service = serviceFor(BASE_NETWORK, provider);

    await expect(service.assertRuntimeCompatibility()).resolves.toBeUndefined();
  });

  it('fails fast when EIP-1559 is declared but baseFeePerGas is missing', async () => {
    const provider = {
      getBlockHeight: jest.fn().mockResolvedValue(100),
      getManyBlocksByHeights: jest.fn().mockResolvedValue([block()]),
    };

    const service = serviceFor(BASE_NETWORK, provider);

    await expect(service.assertRuntimeCompatibility()).rejects.toThrow('baseFeePerGas');
  });

  it('fails fast when subscribe-ws mempool strategy has no websocket provider', async () => {
    const provider = {
      getBlockHeight: jest.fn().mockResolvedValue(100),
      getManyBlocksByHeights: jest.fn().mockResolvedValue([block({ baseFeePerGas: '0x3b9aca00' })]),
    };
    const mempoolManager = {
      isAvailable: true,
      getActiveProvider: jest.fn().mockReturnValue({ hasWebSocketSupport: false }),
    };

    const service = serviceFor(BASE_NETWORK, provider, mempoolManager);

    await expect(service.assertRuntimeCompatibility({ mempoolStrategy: 'subscribe-ws' })).rejects.toThrow('websocket');
  });
});
