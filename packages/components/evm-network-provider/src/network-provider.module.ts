import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { NetworkProviderService } from './network-provider.service';
import { ConnectionManager } from './connection-manager';
import { EtherJSUtil, Web3Util } from './utils';
import { createProvider, ProviderOptions, EtherJSProvider, Web3jsProvider } from './node-providers';

export interface NetworkProviderModuleOptions {
  providers?: ProviderOptions[];
  isGlobal?: boolean;
  etherJsHttpUrls?: string[]; // TODO: add websockets
  web3JsHttpUrls?: string[]; // TODO: add websockets
  network?: string;
}

@Module({})
export class NetworkProviderModule {
  static async forRootAsync(options: NetworkProviderModuleOptions): Promise<DynamicModule> {
    const { providers, isGlobal, etherJsHttpUrls, web3JsHttpUrls, ...restOptions } = options;

    // Create EtherJS providers
    const etherJSProviders: ProviderOptions[] = [];
    if (etherJsHttpUrls) {
      for (const baseUrl of etherJsHttpUrls) {
        etherJSProviders.push({
          useFactory: () =>
            new EtherJSProvider({
              uniqName: `EtherJSProvider_${uuidv4()}`,
              baseUrl,
              ...restOptions,
            }),
        });
      }
    }

    // Create Web3jsProvider providers
    const web3jsProviders: ProviderOptions[] = [];
    if (web3JsHttpUrls) {
      for (const baseUrl of web3JsHttpUrls) {
        web3jsProviders.push({
          useFactory: () =>
            new Web3jsProvider({
              uniqName: `Web3jsProvider_${uuidv4()}`,
              baseUrl,
              ...restOptions,
            }),
        });
      }
    }

    const providersToConnect: ProviderOptions[] = [...etherJSProviders, ...web3jsProviders, ...(providers || [])];

    const providersInstance = providersToConnect.map(async (providerOptions) => {
      if (providerOptions.useFactory) {
        return await providerOptions.useFactory();
      } else if (providerOptions.connection) {
        const { connection } = providerOptions;
        return createProvider(connection);
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
