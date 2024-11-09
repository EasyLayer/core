import { v4 as uuidv4 } from 'uuid';
import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { NetworkProviderService } from './network-provider.service';
import { ConnectionManager } from './connection-manager';
import { KeyManagementService, ScriptUtilService, WalletService, TransactionService } from './utils';
import { WebhookStreamService } from './webhook-stream.service';
import { createProvider, ProviderOptions, QuickNodeProvider, SelfNodeProvider } from './node-providers';

export interface NetworkProviderModuleOptions {
  providers?: ProviderOptions[];
  isGlobal?: boolean;
  quickNodesUrls?: string[];
  selfNodesUrl?: string;
  maxRequestContentLength?: number;
  responseTimeout?: number;
  network?: string;
}

@Module({})
export class NetworkProviderModule {
  static async forRootAsync(options: NetworkProviderModuleOptions): Promise<DynamicModule> {
    const { providers, isGlobal, quickNodesUrls, selfNodesUrl, ...restOptions } = options;

    // Create QuickNode providers
    const quickNodeProviders: ProviderOptions[] = [];
    if (quickNodesUrls) {
      for (const quickNodeProviderOption of quickNodesUrls) {
        quickNodeProviders.push({
          useFactory: () =>
            new QuickNodeProvider({
              uniqName: `QuickNodeProvider_${uuidv4()}`,
              baseUrl: quickNodeProviderOption,
              ...restOptions,
            }),
        });
      }
    }

    // Create SelfNode providers
    const selfNodeProviders: ProviderOptions[] = [];
    if (selfNodesUrl) {
      selfNodeProviders.push({
        useFactory: () =>
          new SelfNodeProvider({
            uniqName: `SelfNodeProvider_${uuidv4()}`,
            baseUrl: selfNodesUrl,
            ...restOptions,
          }),
      });
    }

    const providersToConnect: ProviderOptions[] = [...quickNodeProviders, ...selfNodeProviders, ...(providers || [])];

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
      imports: [LoggerModule.forRoot({ componentName: 'BitcoinNetworkProvider' })],
      providers: [
        NetworkProviderService,
        WebhookStreamService,
        connectionManager,
        KeyManagementService,
        ScriptUtilService,
        WalletService,
        TransactionService,
      ],
      exports: [
        NetworkProviderService,
        WebhookStreamService,
        ConnectionManager,
        KeyManagementService,
        ScriptUtilService,
        WalletService,
        TransactionService,
      ],
    };
  }
}
