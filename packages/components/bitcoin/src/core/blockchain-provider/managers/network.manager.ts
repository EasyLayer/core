import type { NetworkProvider } from '../providers';
import { BaseConnectionManager } from './base.manager';

export class NetworkConnectionManager extends BaseConnectionManager<NetworkProvider> {
  private activeProviderName!: string;
  private failedProviders: Set<string> = new Set();
  private reconnectionAttempts: Map<string, number> = new Map();
  // 3 attempts with immediate retry — enough to survive transient blips without long delays.
  // After 3 failures, switch to the next provider without waiting.
  private readonly maxReconnectionAttempts = 3;
  private p2pInitialized: Set<string> = new Set();

  // TTL for failedProviders entries — providers are automatically un-blacklisted after 5 min.
  // Prevents permanent dead state when all providers hit the failed list during a network blip.
  private failedAt: Map<string, number> = new Map();
  private readonly failedProviderTtlMs = 5 * 60 * 1000; // 5 min

  // Guard against concurrent handleProviderFailure calls corrupting state.
  // JS is single-threaded but interleaved awaits can cause double-increments etc.
  private isRecovering = false;

  /**
   * Single-active strategy with automatic failover.
   * 1) Connect all providers (idempotent).
   * 2) Prefer healthy P2P, then healthy non-P2P.
   * 3) Initialize P2P once per provider.
   */
  async initialize(): Promise<void> {
    const { connected, failed } = await this.ensureConnectedAll();

    if (failed.length > 0) {
      this.logger.verbose('Some network providers failed to connect on init', {
        module: this.moduleName,
        args: { failed: failed.map((p) => p.uniqName) },
      });
    }

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
    this.failedAt.delete(name);
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
    // If another concurrent failure is already being handled, wait briefly and
    // return whatever provider is active after recovery completes.
    // Prevents double-increment of reconnectionAttempts and unpredictable activeProviderName writes.
    if (this.isRecovering) {
      await new Promise((r) => setTimeout(r, 300));
      return this.getActiveProvider() as Promise<NetworkProvider>;
    }

    this.isRecovering = true;

    try {
      // Clean up stale failedProviders entries (TTL-based auto-recovery).
      // Ensures providers that recovered externally are not permanently blacklisted.
      const now = Date.now();
      for (const [name, ts] of this.failedAt) {
        if (now - ts > this.failedProviderTtlMs) {
          this.failedProviders.delete(name);
          this.reconnectionAttempts.delete(name);
          this.failedAt.delete(name);
        }
      }

      this.logger.verbose('Provider operation failed, attempting recovery', {
        module: this.moduleName,
        args: { providerName, methodName, error: (error as any)?.message ?? 'Unknown error' },
      });

      const failedProvider = await this.getProviderByName(providerName);
      this.failedProviders.add(providerName);
      this.failedAt.set(providerName, now);

      const attempts = this.reconnectionAttempts.get(providerName) ?? 0;
      this.reconnectionAttempts.set(providerName, attempts + 1);

      // Try to reconnect the same provider a few times before switching
      if (attempts < this.maxReconnectionAttempts) {
        try {
          const ok = await this.ensureConnected(failedProvider);
          if (ok) {
            if (failedProvider.transportType === 'p2p') {
              await this.ensureP2PInitialized(failedProvider);
            }
            this.failedProviders.delete(providerName);
            this.failedAt.delete(providerName);
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
          this.failedAt.set(next.uniqName, Date.now());
          continue;
        }

        if (next.transportType === 'p2p') {
          await this.ensureP2PInitialized(next);
        }

        const old = this.activeProviderName;
        this.activeProviderName = next.uniqName;
        this.failedProviders.delete(next.uniqName);
        this.failedAt.delete(next.uniqName);
        this.reconnectionAttempts.delete(next.uniqName); // reset so next failure starts fresh

        this.logger.log(`Switched to backup provider: ${old} → ${this.activeProviderName}`, {
          module: this.moduleName,
        });

        return next;
      }

      throw new Error('No working providers available');
    } finally {
      this.isRecovering = false;
    }
  }
  /* eslint-enable no-empty */

  private async ensureP2PInitialized(provider: NetworkProvider): Promise<void> {
    if (this.p2pInitialized.has(provider.uniqName)) return;
    await provider.initializeP2P({ waitForHeaderSync: false, headerSyncTimeout: 60000 });
    this.p2pInitialized.add(provider.uniqName);
  }
}
