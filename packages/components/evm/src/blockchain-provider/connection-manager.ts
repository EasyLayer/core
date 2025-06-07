import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import {
  exponentialIntervalAsync,
  ExponentialTimer,
  IntervalOptions,
} from '@easylayer/common/exponential-interval-async';
import { BaseNodeProvider, ProviderNodeOptions } from './node-providers';

interface ReconnectOptions {
  enabled: boolean;
  healthCheckInterval: IntervalOptions;
  reconnectInterval: IntervalOptions;
}

@Injectable()
export class ConnectionManager implements OnModuleInit, OnModuleDestroy {
  private _providers: Map<string, BaseNodeProvider> = new Map();
  private activeProviderName!: string;
  private healthCheckTimer?: ExponentialTimer;
  private reconnectTimer?: ExponentialTimer;

  private readonly reconnectOptions: ReconnectOptions = {
    enabled: true,
    healthCheckInterval: {
      interval: 30000, // Check every 30 seconds initially
      multiplier: 1.2, // Slight increase on consecutive issues
      maxInterval: 120000, // Max 2 minutes between checks
      maxAttempts: Infinity,
    },
    reconnectInterval: {
      interval: 1000, // Start with 1 second
      multiplier: 2, // Double each time
      maxInterval: 30000, // Max 30 seconds between attempts
      // maxAttempts: 10      // Max 10 reconnection attempts
    },
  };

  constructor(
    providers: BaseNodeProvider[] = [],
    private readonly log: AppLogger,
    reconnectOptions?: Partial<ReconnectOptions>
  ) {
    // Merge default options with provided options
    if (reconnectOptions) {
      this.reconnectOptions = { ...this.reconnectOptions, ...reconnectOptions };
    }

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

        // Start health monitoring
        this.startHealthMonitoring();
        return;
      }

      this.log.warn('Provider connect failed, trying next', {
        args: { providerName: provider.uniqName },
      });
    }
    throw new Error(`Unable to connect to any providers.`);
  }

  async onModuleDestroy() {
    // Stop health monitoring
    this.stopHealthMonitoring();

    // Stop reconnection timer
    if (this.reconnectTimer) {
      this.reconnectTimer.destroy();
      this.reconnectTimer = undefined;
    }

    for (const provider of this._providers.values()) {
      this.log.debug('Disconnecting provider', {
        args: { providerName: provider.uniqName },
      });
      await this.disconnectProvider(provider.uniqName);
    }
  }

  /**
   * Starts periodic health monitoring of the active provider
   */
  private startHealthMonitoring(): void {
    if (!this.reconnectOptions.enabled) {
      return;
    }

    this.stopHealthMonitoring(); // Stop existing timer if any

    this.healthCheckTimer = exponentialIntervalAsync(async (resetInterval) => {
      const healthOk = await this.performHealthCheck();
      if (healthOk) {
        resetInterval(); // Reset interval on successful health check
      }
      // If health check fails, exponential backoff will increase interval
    }, this.reconnectOptions.healthCheckInterval);

    this.log.debug('Health monitoring started with exponential backoff', {
      args: {
        initialInterval: this.reconnectOptions.healthCheckInterval.interval,
        maxInterval: this.reconnectOptions.healthCheckInterval.maxInterval,
      },
    });
  }

  /**
   * Stops health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      this.healthCheckTimer.destroy();
      this.healthCheckTimer = undefined;
      this.log.debug('Health monitoring stopped');
    }
  }

  /**
   * Performs health check on active provider and attempts reconnection if needed
   * @returns true if provider is healthy, false otherwise
   */
  private async performHealthCheck(): Promise<boolean> {
    try {
      const provider = await this.getActiveProvider();

      // Check HTTP health
      const httpHealthy = await provider.healthcheck();
      if (!httpHealthy) {
        this.log.warn('HTTP health check failed for active provider', {
          args: { providerName: this.activeProviderName },
          methodName: 'performHealthCheck',
        });
        await this.handleProviderFailure();
        return false;
      }

      // Check WebSocket health if provider has WebSocket support
      if (this.hasWebSocketSupport(provider)) {
        const wsHealthy = await provider.healthcheckWebSocket();
        if (!wsHealthy) {
          this.log.warn('WebSocket health check failed, starting reconnection process', {
            args: { providerName: this.activeProviderName },
            methodName: 'performHealthCheck',
          });
          this.startWebSocketReconnection(provider);
          return false;
        }
      }

      return true;
    } catch (error) {
      this.log.error('Health check failed', {
        args: { error, providerName: this.activeProviderName },
        methodName: 'performHealthCheck',
      });
      await this.handleProviderFailure();
      return false;
    }
  }

  /**
   * Starts WebSocket reconnection process with exponential backoff
   */
  private startWebSocketReconnection(provider: BaseNodeProvider): void {
    // Stop any existing reconnection timer
    if (this.reconnectTimer) {
      this.reconnectTimer.destroy();
    }

    this.reconnectTimer = exponentialIntervalAsync(async (resetInterval) => {
      try {
        this.log.info('Attempting WebSocket reconnection', {
          args: { providerName: this.activeProviderName },
        });

        await provider.reconnectWebSocket();

        this.log.info('WebSocket reconnection successful', {
          args: { providerName: this.activeProviderName },
        });

        // Stop reconnection timer on success
        if (this.reconnectTimer) {
          this.reconnectTimer.destroy();
          this.reconnectTimer = undefined;
        }

        resetInterval(); // This won't be called since we destroy the timer
      } catch (error) {
        this.log.error('WebSocket reconnection attempt failed', {
          args: {
            error,
            providerName: this.activeProviderName,
          },
        });
        // Exponential backoff will handle the delay for next attempt
      }
    }, this.reconnectOptions.reconnectInterval);
  }

  /**
   * Handles provider failure by attempting to switch to another provider
   */
  private async handleProviderFailure(): Promise<void> {
    this.log.debug('Attempting to switch to backup provider', {
      args: { failedProvider: this.activeProviderName },
    });

    // Try to find a working backup provider
    for (const [name, provider] of this._providers.entries()) {
      if (name === this.activeProviderName) {
        continue; // Skip the currently failing provider
      }

      if (await this.tryConnectProvider(provider)) {
        const oldProvider = this.activeProviderName;
        this.activeProviderName = name;

        this.log.info('Successfully switched to backup provider', {
          args: {
            oldProvider,
            newProvider: this.activeProviderName,
          },
        });
        return;
      }
    }

    this.log.error('No working backup providers found');
  }

  /**
   * Checks if provider has WebSocket support
   */
  private hasWebSocketSupport(provider: BaseNodeProvider): provider is BaseNodeProvider & {
    healthcheckWebSocket(): Promise<boolean>;
    reconnectWebSocket(): Promise<void>;
  } {
    return (
      typeof (provider as any).healthcheckWebSocket === 'function' &&
      typeof (provider as any).reconnectWebSocket === 'function'
    );
  }

  // Get all connections options for all providers
  public connectionOptionsForAllProviders<T extends ProviderNodeOptions>(): T[] {
    const options: T[] = [];
    for (const provider of this._providers.values()) {
      options.push(provider.connectionOptions as T);
    }
    return options;
  }

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
  }

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
