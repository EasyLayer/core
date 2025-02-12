import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { NetworkProviderService } from './network-provider.service';
import { ConnectionManager } from './connection-manager';
import { EtherJSUtil, Web3Util } from './utils';
import { createProvider, ProviderOptions } from './node-providers';

export interface NetworkProviderModuleOptions {
  providers: ProviderOptions[];
  isGlobal?: boolean;
}

@Module({})
export class NetworkProviderModule {
  static async forRootAsync(options: NetworkProviderModuleOptions): Promise<DynamicModule> {
    const { providers, isGlobal } = options;

    const providersInstance = (providers || []).map(async (providerOptions) => {
      if (providerOptions.useFactory) {
        return await providerOptions.useFactory();
      } else if (providerOptions.connection) {
        const { connection } = providerOptions;
        return createProvider({
          ...connection,
          uniqName: `${connection.type.toUpperCase()}_${uuidv4()}`,
        });
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
      module: NetworkProviderModule,
      global: isGlobal || false,
      imports: [LoggerModule.forRoot({ componentName: 'EvmNetworkProvider' })],
      providers: [NetworkProviderService, connectionManager, EtherJSUtil, Web3Util],
      exports: [NetworkProviderService, ConnectionManager, EtherJSUtil, Web3Util],
    };
  }
}
