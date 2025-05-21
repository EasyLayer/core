import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BaseNodeProvider, ProviderNodeOptions } from './node-providers';

@Injectable()
export class ConnectionManager implements OnModuleInit, OnModuleDestroy {
  private _providers: Map<string, BaseNodeProvider> = new Map();
  private activeProviderName!: string;

  constructor(
    providers: BaseNodeProvider[] = [],
    private readonly log: AppLogger
  ) {
    providers.forEach((provider: BaseNodeProvider) => {
      const name = provider.uniqName;
      if (this._providers.has(name)) {
        throw new Error(`An adapter with the name "${name}" has already been added.`);
      }
      this._providers.set(name, provider);

      this.log.info('Blockchain provider registered', {
        args: { providerName: name },
      });
    });
  }

  get providers() {
    return this._providers;
  }

  async onModuleInit() {
    for (const provider of this._providers.values()) {
      if (await this.tryConnectProvider(provider)) {
        this.activeProviderName = provider.uniqName;
        this.log.info(`Connected to provider: ${provider.constructor.name}`, {
          args: { activeProviderName: this.activeProviderName },
        });
        return;
      }

      this.log.warn('Provider connect failed, trying next', {
        args: { providerName: provider.uniqName },
      });
    }
    throw new Error(`Unable to connect to any providers.`);
  }

  async onModuleDestroy() {
    for (const provider of this._providers.values()) {
      this.log.debug('Disconnecting provider', {
        args: { providerName: provider.uniqName },
      });
      await this.disconnectProvider(provider.uniqName);
    }
  }

  // Get all connections options for all providers
  public connectionOptionsForAllProviders<T extends ProviderNodeOptions>(): T[] {
    const options: T[] = [];

    for (const provider of this._providers.values()) {
      options.push(provider.connectionOptions as T);
    }
    return options;
  }

  // Adding new provider dynamically
  // IMPORTANT: we can't add new provider in runtime, just switch from existing

  // public addProvider(provider: BaseNodeProvider): void {
  //   const name = provider.name;
  //   if (this._providers.has(name)) {
  //     throw new Error(`Provider with the name "${name}" already exists.`);
  //   }
  //   this._providers.set(name, provider);
  // }

  // Removing a provider dynamically
  public removeProvider(name: string): boolean {
    if (!this._providers.has(name)) {
      throw new Error(`Provider with name ${name} not found`);
    }
    return this._providers.delete(name);
  }

  // Disconnecting and removing connection for a provider
  public async disconnectProvider(name: string): Promise<void> {
    const provider = await this.getProviderByName(name);
    await provider.disconnect();
    this.log.warn(`Disconnected from provider: ${provider.constructor.name}`, {
      args: { name },
    });
  }

  // Switch active provider
  public async switchProvider(name: string): Promise<void> {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`Provider with name ${name} not found`);
    }

    if (await this.tryConnectProvider(provider)) {
      this.activeProviderName = name;
      this.log.info(`Switched to provider: ${provider.constructor.name}`, {
        args: { name },
      });
    } else {
      throw new Error(`Failed to switch to provider with name ${name}`);
    }
  }

  public async getActiveProvider(): Promise<BaseNodeProvider> {
    const provider = this._providers.get(this.activeProviderName);
    if (!provider) {
      throw new Error(`Provider with name ${this.activeProviderName} not found`);
    }

    return provider;

    // if ((await provider.healthcheck()) || (await this.tryConnectProvider(provider))) {
    //   return provider;
    // }

    // throw new Error('No available providers found');
  }

  // TODO: remove from this adapter connection logic
  public async getProviderByName(name: string): Promise<BaseNodeProvider> {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`Provider with name ${name} not found`);
    }

    // If the requested provider is already active, return it
    if (this.activeProviderName === name) {
      this.log.debug('Requested provider is already active', {
        args: { name },
      });
      return provider;
    }

    this.log.debug('Trying to connect requested provider', {
      args: { name },
    });

    // Trying to connect to the requested provider
    const isConnected = await this.tryConnectProvider(provider);
    if (!isConnected) {
      throw new Error(`Failed to connect to provider with name ${name}`);
    }

    // Disable the current active adapter if necessary
    if (this.activeProviderName && this.activeProviderName !== name) {
      const current = this._providers.get(this.activeProviderName)!;
      this.log.debug('Disconnecting current active provider', {
        args: { name: this.activeProviderName },
      });
      try {
        await current.disconnect();
        this.log.info(`Disconnected from provider: ${current.constructor.name}`, {
          args: { oldProvider: this.activeProviderName },
        });
      } catch (error) {
        this.log.debug('Error while disconnecting old provider', {
          args: error,
        });
      }
    }

    // Update the active adapter
    this.activeProviderName = name;
    this.log.info(`Connected to adapter: ${provider.constructor.name}`, {
      args: { name },
    });
    return provider;
  }

  private async tryConnectProvider(provider: BaseNodeProvider): Promise<boolean> {
    try {
      await provider.connect();
      return true;
    } catch (error) {
      return false;
    }
  }
}
