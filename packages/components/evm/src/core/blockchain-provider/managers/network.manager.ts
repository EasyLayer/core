import { BaseConnectionManager, type ManagedProvider } from './base.manager';
import type { Hash, UniversalBlock, UniversalBlockStats, UniversalTrace } from '../providers/interfaces';

export interface EvmNetworkProvider extends ManagedProvider {
  reconnectWebSocket?(): Promise<void>;
  hasWebSocketSupport?: boolean;
  isWebSocketConnected?: boolean;
  subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe(): void };
  getBlockHeight(): Promise<number>;
  getManyBlocksByHeights(
    heights: number[],
    fullTransactions?: boolean,
    verifyTrie?: boolean
  ): Promise<Array<UniversalBlock | null>>;
  getManyBlocksByHashes(hashes: Hash[], fullTransactions?: boolean): Promise<Array<UniversalBlock | null>>;
  getManyBlocksStatsByHeights(heights: number[]): Promise<Array<UniversalBlockStats | null>>;
  getManyBlocksWithReceipts(
    heights: string[] | number[],
    fullTransactions?: boolean,
    verifyTrie?: boolean
  ): Promise<Array<UniversalBlock | null>>;
  assertTraceSupport(): Promise<void>;
  getTracesByBlockNumber(blockNumber: number): Promise<UniversalTrace[]>;
  getTracesByTxHash(hash: string): Promise<UniversalTrace[]>;
}

export class NetworkConnectionManager<
  T extends EvmNetworkProvider = EvmNetworkProvider,
> extends BaseConnectionManager<T> {
  private activeProviderName = '';
  private failedProviders: Set<string> = new Set();
  private reconnectionAttempts: Map<string, number> = new Map();
  private readonly maxReconnectionAttempts = 3;
  private failedAt: Map<string, number> = new Map();
  private readonly failedProviderTtlMs = 5 * 60 * 1000;
  private isRecovering = false;

  async initialize(): Promise<void> {
    const { connected, failed } = await this.ensureConnectedAll();
    if (failed.length > 0) {
      this.logger.verbose?.('Some EVM network providers failed to connect on init', {
        module: this.moduleName,
        args: { failed: failed.map((p) => p.uniqName) },
      } as any);
    }
    if (connected.length === 0) throw new Error('Unable to connect to any EVM network providers');

    for (const provider of connected) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (!healthy) continue;
      this.activeProviderName = provider.uniqName;
      this.logger.log?.(`Active EVM network provider set: ${provider.uniqName}`, { module: this.moduleName } as any);
      return;
    }
    throw new Error('No healthy EVM network providers available');
  }

  async switchActiveProvider(name: string): Promise<void> {
    const provider = await this.getProviderByName(name);
    const ok = await this.ensureConnected(provider);
    if (!ok) throw new Error(`Provider ${name} is not connected`);
    this.failedProviders.delete(name);
    this.reconnectionAttempts.delete(name);
    this.failedAt.delete(name);
    this.activeProviderName = name;
  }

  async getActiveProvider(): Promise<T> {
    const provider = this.providers.get(this.activeProviderName);
    if (!provider) throw new Error(`Active provider ${this.activeProviderName} not found`);
    return provider;
  }

  async handleProviderFailure(providerName: string, error: unknown, methodName: string): Promise<T> {
    if (this.isRecovering) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return this.getActiveProvider();
    }

    this.isRecovering = true;
    try {
      const now = Date.now();
      for (const [name, ts] of this.failedAt) {
        if (now - ts > this.failedProviderTtlMs) {
          this.failedProviders.delete(name);
          this.reconnectionAttempts.delete(name);
          this.failedAt.delete(name);
        }
      }

      const failedProvider = await this.getProviderByName(providerName);
      this.failedProviders.add(providerName);
      this.failedAt.set(providerName, now);

      const attempts = this.reconnectionAttempts.get(providerName) ?? 0;
      this.reconnectionAttempts.set(providerName, attempts + 1);

      if (attempts < this.maxReconnectionAttempts) {
        const ok = await this.ensureConnected(failedProvider);
        if (ok) {
          this.failedProviders.delete(providerName);
          this.failedAt.delete(providerName);
          return failedProvider;
        }
      }

      const candidates = Array.from(this.providers.values()).filter((p) => !this.failedProviders.has(p.uniqName));
      for (const candidate of candidates) {
        const ok = await this.ensureConnected(candidate);
        if (!ok) continue;
        const healthy = await candidate.healthcheck().catch(() => false);
        if (!healthy) continue;
        this.activeProviderName = candidate.uniqName;
        return candidate;
      }

      this.failedProviders.clear();
      this.failedAt.clear();
      this.reconnectionAttempts.clear();
      throw error instanceof Error ? error : new Error(`EVM provider failure in ${methodName}`);
    } finally {
      this.isRecovering = false;
    }
  }
}
