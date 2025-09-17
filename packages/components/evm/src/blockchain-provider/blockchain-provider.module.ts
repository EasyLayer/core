import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule } from '@nestjs/common';
import { BlockchainProviderService } from './blockchain-provider.service';
import { ConnectionManager } from './connection-manager';
import { EtherJSUtil, Web3Util } from './utils';
import { createProvider, ProviderOptions, RateLimits, NetworkConfig } from './node-providers';

export interface BlockchainProviderModuleOptions {
  providers: ProviderOptions[];
  network: NetworkConfig;
  isGlobal?: boolean;
  rateLimits: RateLimits;
}
@Module({})
export class BlockchainProviderModule {
  static async forRootAsync(options: BlockchainProviderModuleOptions): Promise<DynamicModule> {
    const { providers, isGlobal, rateLimits, network } = options;

    const providersInstance = (providers || []).map(async (providerOptions) => {
      if (providerOptions.useFactory) {
        return await providerOptions.useFactory();
      } else if (providerOptions.connection) {
        const { connection } = providerOptions;
        return createProvider({
          ...connection,
          uniqName: `${connection.type.toUpperCase()}_${uuidv4()}`,
          rateLimits,
          network,
        });
      } else {
        throw new Error('Provider configuration is invalid.');
      }
    });

    const connectionManager = {
      provide: ConnectionManager,
      useFactory: async () => {
        const adapters = await Promise.all(providersInstance);
        return new ConnectionManager(adapters);
      },
      inject: [],
    };

    return {
      module: BlockchainProviderModule,
      global: isGlobal || false,
      imports: [],
      providers: [
        {
          provide: BlockchainProviderService,
          useFactory: (connectionManager) => {
            return new BlockchainProviderService(connectionManager, network);
          },
          inject: [ConnectionManager],
        },
        connectionManager,
        EtherJSUtil,
        Web3Util,
      ],
      exports: [BlockchainProviderService, ConnectionManager, EtherJSUtil, Web3Util],
    };
  }
}
