import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule, Logger } from '@nestjs/common';
import {
  BlockchainProviderService,
  NetworkConnectionManager,
  MempoolConnectionManager,
} from '../../core/blockchain-provider';
import { createProvider } from '../../core/blockchain-provider/providers';
import type { RateLimits, NetworkConfig } from '../../core/blockchain-provider/providers';

interface ProviderConnectionOptions {
  httpUrl?: string;
  wsUrl?: string;
}

export interface BlockchainProviderModuleOptions {
  isGlobal?: boolean;
  network: NetworkConfig;
  rateLimits: RateLimits;
  networkProviders: {
    type: 'ethersjs' | 'web3js';
    connections: Array<{ httpUrl: string; wsUrl?: string }>;
  };
  /**
   * If omitted, mempoolProviders = null → mempool is disabled.
   * WebSocket connections are required for subscribe-ws strategy.
   * HTTP RPC-only connections are valid for txpool-content strategy.
   */
  mempoolProviders?: {
    type: 'ethersjs' | 'web3js';
    connections: Array<ProviderConnectionOptions>;
  };
}

@Module({})
export class BlockchainProviderModule {
  static async forRootAsync(options: BlockchainProviderModuleOptions): Promise<DynamicModule> {
    const { networkProviders, mempoolProviders, isGlobal, rateLimits, network } = options;

    const buildNetworkProviders = () =>
      networkProviders.connections.map((conn, i) =>
        createProvider({
          type: networkProviders.type as any,
          uniqName: `network_${networkProviders.type}_${i + 1}_${uuidv4()}`,
          httpUrl: conn.httpUrl,
          wsUrl: conn.wsUrl,
          rateLimits,
          network,
        })
      );

    const buildMempoolProviders = () =>
      mempoolProviders
        ? mempoolProviders.connections
            .filter((conn) => Boolean(conn.httpUrl || conn.wsUrl))
            .map((conn, i) =>
              createProvider({
                type: mempoolProviders.type as any,
                uniqName: `mempool_${mempoolProviders.type}_${i + 1}_${uuidv4()}`,
                httpUrl: conn.httpUrl || conn.wsUrl!,
                wsUrl: conn.wsUrl,
                rateLimits,
                network,
              })
            )
        : [];

    const providers = [
      {
        provide: NetworkConnectionManager,
        useFactory: async () => {
          const providerInstances = buildNetworkProviders();
          const manager = new NetworkConnectionManager({
            providers: providerInstances,
            logger: new Logger(NetworkConnectionManager.name),
          });
          await manager.initialize();
          return manager;
        },
        inject: [],
      },
      {
        provide: MempoolConnectionManager,
        useFactory: async () => {
          const providerInstances = buildMempoolProviders();
          const manager = new MempoolConnectionManager({
            providers: providerInstances,
            logger: new Logger(MempoolConnectionManager.name),
          });
          await manager.initialize();
          return manager;
        },
        inject: [],
      },
      {
        provide: BlockchainProviderService,
        useFactory: (networkManager: NetworkConnectionManager, mempoolManager: MempoolConnectionManager) =>
          new BlockchainProviderService(networkManager, mempoolManager, network),
        inject: [NetworkConnectionManager, MempoolConnectionManager],
      },
    ];

    return {
      module: BlockchainProviderModule,
      global: isGlobal || false,
      imports: [],
      providers,
      exports: [BlockchainProviderService],
    };
  }
}
