import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule, Logger } from '@nestjs/common';
import {
  BlockchainProviderService,
  NetworkConnectionManager,
  MempoolConnectionManager,
} from '../../core/blockchain-provider';
import { createProvider } from '../../core/blockchain-provider/providers';
import type { RateLimits, NetworkConfig } from '../../core/blockchain-provider/providers';

export interface BrowserBlockchainProviderModuleOptions {
  isGlobal?: boolean;
  network: NetworkConfig;
  rateLimits: RateLimits;
  providers: {
    type: 'ethersjs' | 'web3js';
    connections: Array<{ httpUrl: string }>;
  };
}

@Module({})
export class BrowserBlockchainProviderModule {
  static async forRootAsync(options: BrowserBlockchainProviderModuleOptions): Promise<DynamicModule> {
    const { providers, isGlobal, rateLimits, network } = options;
    const instances = providers.connections.map((conn, i) =>
      createProvider({
        type: providers.type as any,
        uniqName: `browser_${providers.type}_${i + 1}_${uuidv4()}`,
        httpUrl: conn.httpUrl,
        rateLimits,
        network,
      })
    );

    return {
      module: BrowserBlockchainProviderModule,
      global: isGlobal || false,
      providers: [
        {
          provide: NetworkConnectionManager,
          useFactory: async () => {
            const manager = new NetworkConnectionManager({
              providers: instances,
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
            const manager = new MempoolConnectionManager({
              providers: [],
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
      ],
      exports: [BlockchainProviderService],
    };
  }
}
