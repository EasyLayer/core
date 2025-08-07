import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { BlockchainProviderService } from './blockchain-provider.service';
import { ConnectionManager } from './connection-manager';
import { KeyManagementService, ScriptUtilService, WalletService, TransactionService } from './utils';
import { createProvider, ProviderOptions, ProviderNodeOptions, NetworkConfig, RateLimits } from './node-providers';

export interface BlockchainProviderModuleOptions {
  providers: ProviderOptions[];
  isGlobal?: boolean;
  network: NetworkConfig;
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

        // Create properly typed provider options
        const fullProviderOptions: ProviderNodeOptions = {
          ...connection,
          uniqName: `${connection.type.toUpperCase()}_${uuidv4()}`,
          rateLimits,
          network,
        } as ProviderNodeOptions;

        return createProvider(fullProviderOptions);
      } else {
        throw new Error('Provider configuration is invalid.');
      }
    });

    const connectionManager = {
      provide: ConnectionManager,
      useFactory: async (logger: AppLogger) => {
        const adapters = await Promise.all(providersInstance);
        return new ConnectionManager(adapters, logger);
      },
      inject: [AppLogger],
    };

    return {
      module: BlockchainProviderModule,
      global: isGlobal || false,
      imports: [LoggerModule.forRoot({ componentName: BlockchainProviderModule.name })],
      providers: [
        {
          provide: BlockchainProviderService,
          useFactory: (logger: AppLogger, connectionManager: ConnectionManager) => {
            return new BlockchainProviderService(logger, connectionManager, network);
          },
          inject: [AppLogger, ConnectionManager],
        },
        connectionManager,
        KeyManagementService,
        ScriptUtilService,
        WalletService,
        TransactionService,
      ],
      exports: [
        BlockchainProviderService,
        ConnectionManager,
        KeyManagementService,
        ScriptUtilService,
        WalletService,
        TransactionService,
      ],
    };
  }
}
