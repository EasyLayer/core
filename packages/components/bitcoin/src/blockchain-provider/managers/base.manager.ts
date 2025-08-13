import type { AppLogger } from '@easylayer/common/logger';

export interface BaseConnectionManagerOptions<T> {
  providers: T[];
  logger: AppLogger;
}

export abstract class BaseConnectionManager<
  T extends {
    uniqName: string;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    healthcheck(): Promise<boolean>;
  },
> {
  protected providers: Map<string, T> = new Map();
  protected logger: AppLogger;

  // Track failed providers for round-robin retry
  protected failedProviders: Set<string> = new Set();
  protected reconnectionAttempts: Map<string, number> = new Map();
  protected readonly maxReconnectionAttempts = 3;

  constructor(options: BaseConnectionManagerOptions<T>) {
    this.logger = options.logger;

    options.providers.forEach((provider) => {
      const name = provider.uniqName;
      if (this.providers.has(name)) {
        throw new Error(`A provider with the name "${name}" has already been added.`);
      }
      this.providers.set(name, provider);

      this.logger.debug('Provider registered', {
        args: { providerName: name, providerType: (provider as any).type },
      });
    });
  }

  get allProviders(): T[] {
    return Array.from(this.providers.values());
  }

  /**
   * Initialize all providers - try to connect at least one
   */
  async initialize(): Promise<void> {
    const allProviders = Array.from(this.providers.values());

    let connectedCount = 0;
    for (const provider of allProviders) {
      try {
        if (await this.tryConnectProvider(provider)) {
          connectedCount++;
          this.logger.info(`Connected to provider: ${(provider as any).constructor.name}`, {
            args: { providerName: provider.uniqName, providerType: (provider as any).type },
          });
        }
      } catch (error: any) {
        this.logger.warn('Provider connection failed', {
          args: {
            providerName: provider.uniqName,
            error: error.message || 'Unknown error',
          },
        });
      }
    }

    if (connectedCount === 0) {
      throw new Error('Unable to connect to any providers');
    }

    this.logger.info(`Connection manager initialized with ${connectedCount}/${allProviders.length} providers`);
  }

  /**
   * Cleanup all providers
   */
  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      this.logger.debug('Disconnecting provider', {
        args: { providerName: provider.uniqName },
      });
      try {
        await provider.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting provider during cleanup', {
          args: { error, providerName: provider.uniqName },
        });
      }
    }
  }

  /**
   * Handle provider failure and attempt recovery
   */
  async handleProviderFailure(providerName: string, error: any, methodName: string): Promise<T> {
    this.logger.warn('Provider operation failed, attempting recovery', {
      args: {
        providerName,
        methodName,
        error: error.message || 'Unknown error',
      },
    });

    const failedProvider = this.providers.get(providerName);
    if (!failedProvider) {
      throw new Error(`Provider ${providerName} not found`);
    }

    // Mark provider as failed
    this.failedProviders.add(providerName);

    // Increment reconnection attempts
    const attempts = this.reconnectionAttempts.get(providerName) || 0;
    this.reconnectionAttempts.set(providerName, attempts + 1);

    // Try to reconnect current provider first
    if (attempts < this.maxReconnectionAttempts) {
      this.logger.debug('Attempting to reconnect current provider', {
        args: { providerName, attempt: attempts + 1 },
      });

      try {
        await failedProvider.disconnect();
        if (await this.tryConnectProvider(failedProvider)) {
          this.logger.info('Provider reconnection successful', {
            args: { providerName },
          });

          // Reset failure state on successful reconnection
          this.failedProviders.delete(providerName);
          this.reconnectionAttempts.delete(providerName);
          return failedProvider;
        }
      } catch (reconnectError) {
        this.logger.warn('Provider reconnection failed', {
          args: {
            providerName,
            attempt: attempts + 1,
            error: reconnectError,
          },
        });
      }
    }

    // Let specific implementations handle provider switching
    return await this.handleProviderSwitching(failedProvider);
  }

  /**
   * Abstract method for provider switching strategy
   */
  protected abstract handleProviderSwitching(failedProvider: T): Promise<T>;

  /**
   * Try to connect to a provider
   */
  protected async tryConnectProvider(provider: T): Promise<boolean> {
    try {
      await provider.connect();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get provider by name
   */
  async getProviderByName(name: string): Promise<T> {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider with name ${name} not found`);
    }
    return provider;
  }

  /**
   * Remove a provider
   */
  async removeProvider(name: string): Promise<boolean> {
    if (!this.providers.has(name)) {
      throw new Error(`Provider with name ${name} not found`);
    }

    const provider = this.providers.get(name)!;
    try {
      await provider.disconnect();
    } catch (error) {
      this.logger.error('Error disconnecting provider during removal', {
        args: { error, name },
      });
    }

    // Clean up failure tracking
    this.failedProviders.delete(name);
    this.reconnectionAttempts.delete(name);

    return this.providers.delete(name);
  }

  /**
   * Get connection options for all providers
   */
  getConnectionOptionsForAllProviders(): any[] {
    const options: any[] = [];
    for (const provider of this.providers.values()) {
      options.push((provider as any).connectionOptions);
    }
    return options;
  }
}
