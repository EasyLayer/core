import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BaseNodeProvider, ProviderNodeOptions } from './node-providers';

@Injectable()
export class ConnectionManager implements OnModuleInit, OnModuleDestroy {
  private _providers: Map<string, BaseNodeProvider> = new Map();
  private activeProviderName!: string;

  // Track failed providers to implement round-robin retry
  private failedProviders: Set<string> = new Set();
  private reconnectionAttempts: Map<string, number> = new Map();
  private readonly maxReconnectionAttempts = 3;

  constructor(
    providers: BaseNodeProvider[] = [],
    private readonly log: AppLogger
  ) {
    providers.forEach((provider: BaseNodeProvider) => {
      const name = provider.uniqName;
      if (this._providers.has(name)) {
        throw new Error(`A provider with the name "${name}" has already been added.`);
      }
      this._providers.set(name, provider);

      this.log.debug('Bitcoin provider registered', {
        args: { providerName: name },
      });
    });
  }

  get providers() {
    return this._providers;
  }

  async onModuleInit() {
    const allProviders = Array.from(this._providers.values());

    // Try each provider in order until one connects successfully
    for (const provider of allProviders) {
      try {
        if (await this.tryConnectProvider(provider)) {
          this.activeProviderName = provider.uniqName;
          this.log.info(`Connected to Bitcoin provider: ${provider.constructor.name}`, {
            args: { activeProviderName: this.activeProviderName },
          });
          return;
        }
      } catch (error: any) {
        this.log.warn('Bitcoin provider connection failed, trying next', {
          args: {
            providerName: provider.uniqName,
            error: error.message || 'Unknown error',
          },
        });
      }
    }

    throw new Error('Unable to connect to any Bitcoin providers');
  }

  async onModuleDestroy() {
    for (const provider of this._providers.values()) {
      this.log.debug('Disconnecting Bitcoin provider', {
        args: { providerName: provider.uniqName },
      });
      try {
        await provider.disconnect();
      } catch (error) {
        this.log.warn('Error disconnecting Bitcoin provider during cleanup', {
          args: { error, providerName: provider.uniqName },
        });
      }
    }
  }

  /**
   * Handle provider failure and attempt recovery
   * This method is called when any provider operation fails
   */
  public async handleProviderFailure(providerName: string, error: any, methodName: string): Promise<BaseNodeProvider> {
    this.log.warn('Bitcoin provider operation failed, attempting recovery', {
      args: {
        providerName,
        methodName,
        error: error.message || 'Unknown error',
      },
    });

    const failedProvider = this._providers.get(providerName);
    if (!failedProvider) {
      throw new Error(`Bitcoin provider ${providerName} not found`);
    }

    // Mark provider as failed
    this.failedProviders.add(providerName);

    // Increment reconnection attempts
    const attempts = this.reconnectionAttempts.get(providerName) || 0;
    this.reconnectionAttempts.set(providerName, attempts + 1);

    // Try to reconnect the current provider first
    if (attempts < this.maxReconnectionAttempts) {
      this.log.debug('Attempting to reconnect current Bitcoin provider', {
        args: { providerName, attempt: attempts + 1 },
      });

      try {
        // Full provider reconnection for Bitcoin
        await failedProvider.disconnect();
        if (await this.tryConnectProvider(failedProvider)) {
          this.log.info('Bitcoin provider reconnection successful', {
            args: { providerName },
          });

          // Reset failure state on successful reconnection
          this.failedProviders.delete(providerName);
          this.reconnectionAttempts.delete(providerName);
          return failedProvider;
        }
      } catch (reconnectError) {
        this.log.warn('Bitcoin provider reconnection failed', {
          args: {
            providerName,
            attempt: attempts + 1,
            error: reconnectError,
          },
        });
      }
    }

    // Try switching to another provider
    return await this.switchToNextAvailableProvider();
  }

  /**
   * Switch to the next available provider in round-robin fashion
   */
  private async switchToNextAvailableProvider(): Promise<BaseNodeProvider> {
    const allProviders = Array.from(this._providers.values());
    const currentIndex = allProviders.findIndex((p) => p.uniqName === this.activeProviderName);

    // Try providers starting from the next one after current
    for (let i = 1; i <= allProviders.length; i++) {
      const nextIndex = (currentIndex + i) % allProviders.length;
      const nextProvider = allProviders[nextIndex];

      if (!nextProvider) continue;

      // Skip recently failed providers unless all providers have failed
      if (this.failedProviders.has(nextProvider.uniqName) && this.failedProviders.size < allProviders.length) {
        continue;
      }

      this.log.debug('Attempting to switch to Bitcoin provider', {
        args: {
          fromProvider: this.activeProviderName,
          toProvider: nextProvider.uniqName,
        },
      });

      try {
        if (await this.tryConnectProvider(nextProvider)) {
          const oldProvider = this.activeProviderName;
          this.activeProviderName = nextProvider.uniqName;

          // Reset failure state for the new active provider
          this.failedProviders.delete(nextProvider.uniqName);
          this.reconnectionAttempts.delete(nextProvider.uniqName);

          this.log.info('Successfully switched to backup Bitcoin provider', {
            args: {
              oldProvider,
              newProvider: this.activeProviderName,
            },
          });

          return nextProvider;
        }
      } catch (error) {
        this.log.warn('Failed to switch to Bitcoin provider', {
          args: {
            providerName: nextProvider.uniqName,
            error: error || 'Unknown error',
          },
        });

        // Mark this provider as failed too
        this.failedProviders.add(nextProvider.uniqName);
      }
    }

    // If all providers have failed, reset failure state and try again
    if (this.failedProviders.size >= allProviders.length) {
      this.log.warn('All Bitcoin providers have failed, resetting failure state', {
        args: { totalProviders: allProviders.length },
      });

      this.failedProviders.clear();
      this.reconnectionAttempts.clear();

      // Try the first provider again
      const firstProvider = allProviders[0];
      if (firstProvider && (await this.tryConnectProvider(firstProvider))) {
        this.activeProviderName = firstProvider.uniqName;
        return firstProvider;
      }
    }

    throw new Error('No working Bitcoin providers available');
  }

  /**
   * Get the currently active provider
   * If the provider fails, automatically attempt recovery
   */
  public async getActiveProvider(): Promise<BaseNodeProvider> {
    const provider = this._providers.get(this.activeProviderName);
    if (!provider) {
      throw new Error(`Active Bitcoin provider ${this.activeProviderName} not found`);
    }
    return provider;
  }

  /**
   * Manually switch to a specific provider
   */
  public async switchProvider(name: string): Promise<void> {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`Bitcoin provider with name ${name} not found`);
    }

    if (await this.tryConnectProvider(provider)) {
      this.activeProviderName = name;

      // Reset failure state for manually selected provider
      this.failedProviders.delete(name);
      this.reconnectionAttempts.delete(name);

      this.log.info(`Manually switched to Bitcoin provider: ${provider.constructor.name}`, {
        args: { name },
      });
    } else {
      throw new Error(`Failed to connect to Bitcoin provider ${name}`);
    }
  }

  /**
   * Get provider by name
   */
  public async getProviderByName(name: string): Promise<BaseNodeProvider> {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`Bitcoin provider with name ${name} not found`);
    }
    return provider;
  }

  /**
   * Remove a provider
   */
  public async removeProvider(name: string): Promise<boolean> {
    if (!this._providers.has(name)) {
      throw new Error(`Bitcoin provider with name ${name} not found`);
    }

    // If removing active provider, switch to another one
    if (this.activeProviderName === name) {
      if (this._providers.size > 1) {
        try {
          await this.switchToNextAvailableProvider();
        } catch (error) {
          this.log.error('Failed to switch to backup Bitcoin provider after removal', {
            args: { removedProvider: name, error },
          });
          this.activeProviderName = '';
        }
      } else {
        this.activeProviderName = '';
      }
    }

    // Disconnect and remove the provider
    const provider = this._providers.get(name)!;
    try {
      await provider.disconnect();
    } catch (error) {
      this.log.error('Error disconnecting Bitcoin provider during removal', {
        args: { error, name },
      });
    }

    // Clean up failure tracking
    this.failedProviders.delete(name);
    this.reconnectionAttempts.delete(name);

    return this._providers.delete(name);
  }

  /**
   * Get connection options for all providers
   */
  public connectionOptionsForAllProviders<T extends ProviderNodeOptions>(): T[] {
    const options: T[] = [];
    for (const provider of this._providers.values()) {
      options.push(provider.connectionOptions as T);
    }
    return options;
  }

  /**
   * Try to connect to a provider
   */
  private async tryConnectProvider(provider: BaseNodeProvider): Promise<boolean> {
    try {
      await provider.connect();
      return true;
    } catch (error) {
      return false;
    }
  }
}
