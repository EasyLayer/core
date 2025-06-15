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

// Enum for reconnection types
enum ReconnectionType {
  WEBSOCKET_ONLY = 'websocket',
  FULL_PROVIDER = 'full',
}

@Injectable()
export class ConnectionManager implements OnModuleInit, OnModuleDestroy {
  private _providers: Map<string, BaseNodeProvider> = new Map();
  private activeProviderName!: string;
  private healthCheckTimer?: ExponentialTimer;

  // Single reconnection timer for all types
  private reconnectionTimer?: ExponentialTimer;
  private currentReconnectionType?: ReconnectionType;

  // Flag to prevent parallel health checks
  private isHealthCheckRunning = false;

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
    this.stopReconnection();

    for (const provider of this._providers.values()) {
      this.log.debug('Disconnecting provider', {
        args: { providerName: provider.uniqName },
      });
      try {
        await provider.disconnect();
      } catch (error) {
        this.log.warn('Error disconnecting provider during cleanup', {
          args: { error, providerName: provider.uniqName },
        });
      }
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
   * Starts reconnection process with exponential backoff
   */
  private startReconnection(provider: BaseNodeProvider, type: ReconnectionType): void {
    // Stop any existing reconnection
    this.stopReconnection();

    this.currentReconnectionType = type;

    this.reconnectionTimer = exponentialIntervalAsync(async (resetInterval) => {
      try {
        const success = await this.attemptReconnection(provider, type);

        if (success) {
          this.log.info(`${type} reconnection successful`, {
            args: { providerName: this.activeProviderName, type },
          });

          // Stop timer on success
          this.stopReconnection();
          resetInterval(); // Won't be called since we stop timer
        }
      } catch (error) {
        this.log.error(`${type} reconnection attempt failed`, {
          args: { error, providerName: this.activeProviderName, type },
        });
        // Exponential backoff handles the delay
      }
    }, this.reconnectOptions.reconnectInterval);

    this.log.debug(`Started ${type} reconnection with exponential backoff`, {
      args: {
        providerName: this.activeProviderName,
        type,
        initialInterval: this.reconnectOptions.reconnectInterval.interval,
        maxInterval: this.reconnectOptions.reconnectInterval.maxInterval,
      },
    });
  }

  /**
   * Attempts reconnection based on type
   */
  private async attemptReconnection(provider: BaseNodeProvider, type: ReconnectionType): Promise<boolean> {
    this.log.debug(`Attempting ${type} reconnection`, {
      args: { providerName: this.activeProviderName, type },
    });

    switch (type) {
      case ReconnectionType.WEBSOCKET_ONLY:
        // Only reconnect WebSocket
        await provider.reconnectWebSocket();
        return true;

      case ReconnectionType.FULL_PROVIDER:
        // Full provider reconnection
        try {
          await provider.disconnect();
        } catch (disconnectError) {
          this.log.warn('Error during disconnect before reconnection', {
            args: { error: disconnectError, providerName: this.activeProviderName },
          });
        }

        return await this.tryConnectProvider(provider);

      default:
        throw new Error(`Unknown reconnection type: ${type}`);
    }
  }

  /**
   * Stops any ongoing reconnection
   */
  private stopReconnection(): void {
    if (this.reconnectionTimer) {
      this.reconnectionTimer.destroy();
      this.reconnectionTimer = undefined;
      this.currentReconnectionType = undefined;
      this.log.debug('Reconnection timer stopped');
    }
  }

  /**
   * Performs health check on active provider and attempts reconnection if needed
   * @returns true if provider is healthy, false otherwise
   */
  private async performHealthCheck(): Promise<boolean> {
    // Prevent parallel health checks
    if (this.isHealthCheckRunning) {
      this.log.debug('Health check already running, skipping');
      return true; // Return true to avoid resetting interval
    }

    this.isHealthCheckRunning = true;

    try {
      // Save current active provider for consistency
      const currentActiveProviderName = this.activeProviderName;
      const provider = this._providers.get(currentActiveProviderName);

      if (!provider) {
        this.log.error('Active provider not found during health check');
        return false;
      }

      // Check HTTP health
      const httpHealthy = await provider.healthcheck();
      if (!httpHealthy) {
        this.log.warn('HTTP health check failed for active provider', {
          args: { providerName: currentActiveProviderName },
          methodName: 'performHealthCheck',
        });
        await this.handleProviderFailure();
        return false;
      }

      // Check WebSocket health if provider has WebSocket support
      if (this.hasWebSocketSupport(provider)) {
        const wsHealthy = await provider.healthcheckWebSocket();
        if (!wsHealthy) {
          this.log.warn('WebSocket health check failed, starting WebSocket reconnection', {
            args: { providerName: currentActiveProviderName },
            methodName: 'performHealthCheck',
          });

          // Start WebSocket-only reconnection
          this.startReconnection(provider, ReconnectionType.WEBSOCKET_ONLY);
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
    } finally {
      this.isHealthCheckRunning = false;
    }
  }

  /**
   * Handles provider failure by attempting to switch to another provider
   * or reconnecting the current one if it's the only available provider
   */
  private async handleProviderFailure(): Promise<void> {
    this.log.debug('Attempting to handle provider failure', {
      args: { failedProvider: this.activeProviderName },
    });

    // Check if we have multiple providers
    const hasMultipleProviders = this._providers.size > 1;

    if (hasMultipleProviders) {
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
    } else {
      // Only one provider available - attempt to reconnect it
      this.log.info('Only one provider available, attempting to reconnect', {
        args: { providerName: this.activeProviderName },
      });

      await this.attemptSingleProviderReconnection();
    }
  }

  /**
   * Attempts to reconnect the single available provider with exponential backoff
   */
  private async attemptSingleProviderReconnection(): Promise<void> {
    const provider = this._providers.get(this.activeProviderName);
    if (!provider) {
      this.log.error('Active provider not found during reconnection attempt');
      return;
    }

    // Start full provider reconnection
    this.startReconnection(provider, ReconnectionType.FULL_PROVIDER);
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

  /**
   * Safe provider removal with active provider check
   */
  public async removeProvider(name: string): Promise<boolean> {
    if (!this._providers.has(name)) {
      throw new Error(`Provider with name ${name} not found`);
    }

    // If removing active provider
    if (this.activeProviderName === name) {
      // If there are other providers, switch to one of them
      if (this._providers.size > 1) {
        for (const [otherName, otherProvider] of this._providers.entries()) {
          if (otherName !== name && (await this.tryConnectProvider(otherProvider))) {
            this.log.info('Switched to backup provider after removing active one', {
              args: { removedProvider: name, newProvider: otherName },
            });
            this.activeProviderName = otherName;
            break;
          }
        }
      } else {
        // This is the only provider, stop all monitoring
        this.stopHealthMonitoring();
        this.stopReconnection();
        this.activeProviderName = ''; // Clear active provider
      }
    }

    // Disconnect and remove the provider
    await this.disconnectProvider(name);
    return this._providers.delete(name);
  }

  /**
   * Improved disconnectProvider - doesn't try to connect before disconnect
   */
  public async disconnectProvider(name: string): Promise<void> {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`Provider with name ${name} not found`);
    }

    // If this is active provider, stop its monitoring
    if (this.activeProviderName === name) {
      this.stopHealthMonitoring();
      this.stopReconnection();
    }

    try {
      await provider.disconnect();
      this.log.warn(`Disconnected from provider: ${provider.constructor.name}`, {
        args: { name },
      });
    } catch (error) {
      this.log.error('Error disconnecting provider', {
        args: { error, name },
      });
      throw error;
    }
  }

  /**
   * Switch active provider with proper cleanup
   */
  public async switchProvider(name: string): Promise<void> {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`Provider with name ${name} not found`);
    }

    // Stop monitoring and reconnection of current provider
    this.stopHealthMonitoring();
    this.stopReconnection();

    if (await this.tryConnectProvider(provider)) {
      this.activeProviderName = name;
      this.log.info(`Switched to provider: ${provider.constructor.name}`, {
        args: { name },
      });

      // Start monitoring for new provider
      this.startHealthMonitoring();
    } else {
      // If switch failed, resume monitoring of old provider
      this.startHealthMonitoring();
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

  /**
   * Improved getProviderByName - doesn't auto-connect if not needed
   */
  public async getProviderByName(name: string, autoConnect = false): Promise<BaseNodeProvider> {
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

    // Only try to connect if explicitly requested
    if (!autoConnect) {
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

    // Disconnect the current active provider if necessary
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

    // Update the active provider
    this.activeProviderName = name;
    this.log.info(`Connected to provider: ${provider.constructor.name}`, {
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
