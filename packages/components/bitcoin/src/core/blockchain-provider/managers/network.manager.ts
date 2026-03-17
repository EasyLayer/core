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
      this.logger.error('Unable to connect to any network providers', {
        module: this.moduleName,
      });
      throw new Error('Unable to connect to any providers');
    }

    // Prefer P2P first
    const p2p = connected.filter((p) => p.transportType === 'p2p');
    for (const provider of p2p) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (!healthy) continue;
      await this.ensureP2PInitialized(provider);
      this.activeProviderName = provider.uniqName;
      this.logger.log(`Active network provider set: ${provider.uniqName} (P2P)`, {
        module: this.moduleName,
      });
      return;
    }

    // Fallback to others
    const others = connected.filter((p) => p.transportType !== 'p2p');
    for (const provider of others) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (!healthy) continue;
      this.activeProviderName = provider.uniqName;
      this.logger.log(`Active network provider set: ${provider.uniqName} (RPC)`, {
        module: this.moduleName,
      });
      return;
    }

    this.logger.error('No healthy network providers available after connecting all', {
      module: this.moduleName,
      args: { connected: connected.map((p) => p.uniqName) },
    });
    throw new Error('No healthy providers available for node operations');
  }

  async switchActiveProvider(name: string): Promise<void> {
    const provider = await this.getProviderByName(name);
    if (!provider) throw new Error(`Provider ${name} not registered`);

    const ok = await this.ensureConnected(provider);
    if (!ok) throw new Error(`Provider ${name} is not connected`);

    if (provider.transportType === 'p2p') {
      await this.ensureP2PInitialized(provider);
    }

    this.failedProviders.delete(name);
    this.reconnectionAttempts.delete(name);
    this.activeProviderName = name;

    this.logger.log(`Manually switched active provider to: ${name}`, {
      module: this.moduleName,
    });
  }

  async getActiveProvider(): Promise<NetworkProvider> {
    const provider = this.providers.get(this.activeProviderName);
    if (!provider) throw new Error(`Active provider ${this.activeProviderName} not found`);
    return provider;
  }

  /* eslint-disable no-empty */
  async handleProviderFailure(providerName: string, error: unknown, methodName: string): Promise<NetworkProvider> {
    this.logger.debug('Provider operation failed, attempting recovery', {
      module: this.moduleName,
      args: { providerName, methodName, error: (error as any)?.message ?? 'Unknown error' },
    });

    const failedProvider = await this.getProviderByName(providerName);
    this.failedProviders.add(providerName);

    const attempts = this.reconnectionAttempts.get(providerName) ?? 0;
    this.reconnectionAttempts.set(providerName, attempts + 1);

    // Try to reconnect the same provider a few times
    if (attempts < this.maxReconnectionAttempts) {
      try {
        const ok = await this.ensureConnected(failedProvider);
        if (ok) {
          if (failedProvider.transportType === 'p2p') {
            await this.ensureP2PInitialized(failedProvider);
          }
          this.failedProviders.delete(providerName);
          this.logger.log(`Provider recovered: ${providerName}`, {
            module: this.moduleName,
          });
          return failedProvider;
        }
      } catch {}
    }

    // Fallback to another healthy provider
    for (const next of this.providers.values()) {
      if (next.uniqName === providerName) continue;
      if (this.failedProviders.has(next.uniqName)) continue;

      const ok = await this.ensureConnected(next);
      if (!ok) {
        this.failedProviders.add(next.uniqName);
        continue;
      }

      if (next.transportType === 'p2p') {
        await this.ensureP2PInitialized(next);
      }

      const old = this.activeProviderName;
      this.activeProviderName = next.uniqName;
      this.failedProviders.delete(next.uniqName);
      this.reconnectionAttempts.delete(next.uniqName);

      this.logger.log(`Switched to backup provider: ${old} → ${this.activeProviderName}`, {
        module: this.moduleName,
      });

      return next;
    }

    throw new Error('No working providers available');
  }
  /* eslint-enable no-empty */

  private async ensureP2PInitialized(provider: NetworkProvider): Promise<void> {
    if (this.p2pInitialized.has(provider.uniqName)) return;
    await provider.initializeP2P({ waitForHeaderSync: false, headerSyncTimeout: 60000 });
    this.p2pInitialized.add(provider.uniqName);
  }
}
