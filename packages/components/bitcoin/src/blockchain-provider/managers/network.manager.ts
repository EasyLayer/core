import type { NetworkProvider } from '../providers';
import { BaseConnectionManager } from './base.manager';

export class NetworkConnectionManager extends BaseConnectionManager<NetworkProvider> {
  private activeProviderName!: string;

  async initialize(): Promise<void> {
    await super.initialize();

    // Initialize P2P providers first (they may need header sync)
    const p2pProviders = Array.from(this.providers.values()).filter((p) => p.transport?.type === 'P2P');
    const otherProviders = Array.from(this.providers.values()).filter((p) => p.transport?.type !== 'P2P');

    // Try P2P providers first
    for (const provider of p2pProviders) {
      try {
        if (await provider.healthcheck()) {
          // Initialize P2P-specific functionality
          await provider.initializeP2P({
            waitForHeaderSync: false, // Don't block initialization
            headerSyncTimeout: 60000,
          });

          this.activeProviderName = provider.uniqName;
          this.logger.info(`Set active P2P provider: ${provider.uniqName}`);
          return;
        }
      } catch (error) {
        this.logger.warn(`P2P provider ${provider.uniqName} failed to initialize`, { args: { error } });
      }
    }

    // Fallback to other providers
    for (const provider of otherProviders) {
      try {
        if (await provider.healthcheck()) {
          this.activeProviderName = provider.uniqName;
          this.logger.info(`Set active provider: ${provider.uniqName}`);
          return;
        }
      } catch (error) {
        this.logger.warn(`Provider ${provider.uniqName} failed to initialize`, { args: { error } });
      }
    }

    throw new Error('No healthy providers available for node operations');
  }

  /**
   * Manually switch to a specific provider
   */
  async switchProvider(name: string): Promise<void> {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider with name ${name} not found`);
    }

    if (await this.tryConnectProvider(provider)) {
      this.activeProviderName = name;

      // Reset failure state for manually selected provider
      this.failedProviders.delete(name);
      this.reconnectionAttempts.delete(name);

      this.logger.info(`Manually switched to provider: ${(provider as any).constructor.name}`, {
        args: { name },
      });
    } else {
      throw new Error(`Failed to connect to provider ${name}`);
    }
  }

  /**
   * Get P2P status from all providers
   */
  async getP2PStatus(): Promise<
    Array<{
      providerName: string;
      status: any;
    }>
  > {
    const results = [];

    for (const [name, provider] of this.providers) {
      try {
        const status = await provider.getP2PStatus();
        results.push({
          providerName: name,
          status,
        });
      } catch (error) {
        results.push({
          providerName: name,
          status: { isP2P: false, error: (error as any)?.message },
        });
      }
    }

    return results;
  }

  // Existing methods remain the same...
  async getActiveProvider(): Promise<NetworkProvider> {
    const provider = this.providers.get(this.activeProviderName);
    if (!provider) {
      throw new Error(`Active provider ${this.activeProviderName} not found`);
    }
    return provider;
  }

  protected async handleProviderSwitching(failedProvider: NetworkProvider): Promise<NetworkProvider> {
    return await this.switchToNextAvailableProvider();
  }

  private async switchToNextAvailableProvider(): Promise<NetworkProvider> {
    const allProviders = Array.from(this.providers.values());
    const currentIndex = allProviders.findIndex((p) => p.uniqName === this.activeProviderName);

    for (let i = 1; i <= allProviders.length; i++) {
      const nextIndex = (currentIndex + i) % allProviders.length;
      const nextProvider = allProviders[nextIndex];

      if (!nextProvider) continue;

      if (this.failedProviders.has(nextProvider.uniqName) && this.failedProviders.size < allProviders.length) {
        continue;
      }

      try {
        if (await this.tryConnectProvider(nextProvider)) {
          const oldProvider = this.activeProviderName;
          this.activeProviderName = nextProvider.uniqName;

          // Initialize P2P if needed
          if (nextProvider.transport?.type === 'P2P') {
            await nextProvider.initializeP2P({ waitForHeaderSync: false });
          }

          this.failedProviders.delete(nextProvider.uniqName);
          this.reconnectionAttempts.delete(nextProvider.uniqName);

          this.logger.info('Successfully switched to backup provider', {
            args: { oldProvider, newProvider: this.activeProviderName },
          });

          return nextProvider;
        }
      } catch (error) {
        this.logger.warn('Failed to switch to provider', {
          args: { providerName: nextProvider.uniqName, error },
        });
        this.failedProviders.add(nextProvider.uniqName);
      }
    }

    throw new Error('No working providers available');
  }
}
