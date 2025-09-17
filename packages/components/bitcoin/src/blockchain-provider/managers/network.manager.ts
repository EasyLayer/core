import type { NetworkProvider } from '../providers';
import { BaseConnectionManager } from './base.manager';

export class NetworkConnectionManager extends BaseConnectionManager<NetworkProvider> {
  private activeProviderName!: string;
  private failedProviders: Set<string> = new Set();
  private reconnectionAttempts: Map<string, number> = new Map();
  private readonly maxReconnectionAttempts = 3;
  private p2pInitialized: Set<string> = new Set();

  /**
   * Single-active strategy with automatic failover.
   * 1) Connect all providers (idempotent).
   * 2) Prefer healthy P2P, then healthy non-P2P.
   * 3) Initialize P2P once per provider.
   */
  async initialize(): Promise<void> {
    const { connected } = await this.ensureConnectedAll();
    if (connected.length === 0) {
      throw new Error('Unable to connect to any providers');
    }

    const p2p = connected.filter((p) => p.transport?.type === 'p2p');
    for (const provider of p2p) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (!healthy) continue;
      await this.ensureP2PInitialized(provider);
      this.activeProviderName = provider.uniqName;
      this.logger.debug(`Set active P2P provider: ${provider.uniqName}`);
      return;
    }

    const others = connected.filter((p) => p.transport?.type !== 'p2p');
    for (const provider of others) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (!healthy) continue;
      this.activeProviderName = provider.uniqName;
      this.logger.debug(`Set active provider: ${provider.uniqName}`);
      return;
    }

    throw new Error('No healthy providers available for node operations');
  }

  async switchProvider(name: string): Promise<void> {
    const provider = await this.getProviderByName(name);
    const ok = await this.ensureConnected(provider);
    if (!ok) throw new Error(`Failed to connect to provider ${name}`);

    if (provider.transport?.type === 'p2p') {
      await this.ensureP2PInitialized(provider);
    }

    this.failedProviders.delete(name);
    this.reconnectionAttempts.delete(name);
    this.activeProviderName = name;

    this.logger.debug(`Manually switched to provider: ${(provider as any)?.constructor?.name}`, {
      args: { name },
    });
  }

  async getActiveProvider(): Promise<NetworkProvider> {
    const provider = this.providers.get(this.activeProviderName);
    if (!provider) throw new Error(`Active provider ${this.activeProviderName} not found`);
    return provider;
  }

  /* eslint-disable no-empty */
  async handleProviderFailure(providerName: string, error: unknown, methodName: string): Promise<NetworkProvider> {
    this.logger.warn('Provider operation failed, attempting recovery', {
      args: { providerName, methodName, error: (error as any)?.message ?? 'Unknown error' },
    });

    const failedProvider = await this.getProviderByName(providerName);
    this.failedProviders.add(providerName);

    const attempts = this.reconnectionAttempts.get(providerName) ?? 0;
    this.reconnectionAttempts.set(providerName, attempts + 1);

    if (attempts < this.maxReconnectionAttempts) {
      try {
        await failedProvider.disconnect();
      } catch {}
      this.connected.delete(providerName);

      const ok = await this.ensureConnected(failedProvider);
      if (ok) {
        if (failedProvider.transport?.type === 'p2p') {
          await this.ensureP2PInitialized(failedProvider);
        }
        this.failedProviders.delete(providerName);
        this.reconnectionAttempts.delete(providerName);
        this.activeProviderName = providerName;
        this.logger.log('Provider reconnection successful', { args: { providerName } });
        return failedProvider;
      }
    }

    return await this.switchToNextAvailableProvider();
  }
  /* eslint-enable no-empty */

  private async switchToNextAvailableProvider(): Promise<NetworkProvider> {
    const all = this.allProviders;
    if (!this.activeProviderName) {
      throw new Error('Active provider is not set');
    }

    const currentIndex = all.findIndex((p) => p.uniqName === this.activeProviderName);
    for (let step = 1; step <= all.length; step++) {
      const next = all[(currentIndex + step) % all.length];
      if (!next) continue;

      if (this.failedProviders.has(next.uniqName) && this.failedProviders.size < all.length) {
        continue;
      }

      const ok = await this.ensureConnected(next);
      if (!ok) {
        this.failedProviders.add(next.uniqName);
        continue;
      }

      if (next.transport?.type === 'p2p') {
        await this.ensureP2PInitialized(next);
      }

      const old = this.activeProviderName;
      this.activeProviderName = next.uniqName;
      this.failedProviders.delete(next.uniqName);
      this.reconnectionAttempts.delete(next.uniqName);

      this.logger.debug('Successfully switched to backup provider', {
        args: { oldProvider: old, newProvider: this.activeProviderName },
      });

      return next;
    }

    throw new Error('No working providers available');
  }

  private async ensureP2PInitialized(provider: NetworkProvider): Promise<void> {
    if (this.p2pInitialized.has(provider.uniqName)) return;
    await provider.initializeP2P({ waitForHeaderSync: false, headerSyncTimeout: 60000 });
    this.p2pInitialized.add(provider.uniqName);
  }
}
