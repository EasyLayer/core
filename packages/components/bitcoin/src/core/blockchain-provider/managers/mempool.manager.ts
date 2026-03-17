import type { MempoolProvider } from '../providers';
import { BaseConnectionManager } from './base.manager';

export type MempoolRequestStrategy = 'parallel' | 'round-robin' | 'fastest' | 'single';

export interface MempoolRequestOptions {
  strategy?: MempoolRequestStrategy;
  providerName?: string;
  timeout?: number;
}

function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) return reject(new Error('No promises'));
    let rejected = 0;
    for (const p of promises) {
      p.then(resolve, () => {
        rejected++;
        if (rejected === pending) reject(new Error('All parallel operations failed'));
      });
    }
  });
}

/**
 * Multi-provider strategy:
 * - Connect all providers
 * - No automatic switching inside manager; strategies drive usage
 * - Recovery delegates to per-call handling
 */
export class MempoolConnectionManager extends BaseConnectionManager<MempoolProvider> {
  private currentProviderIndex = 0;

  /**
   * Called once at startup — throw is correct here.
   * If no providers connect, the system cannot function at all.
   */
  async initialize(): Promise<void> {
    const { connected, failed } = await this.ensureConnectedAll();

    if (failed.length > 0) {
      this.logger.debug('Some mempool providers failed to connect on init', {
        module: this.moduleName,
        args: { failed: failed.map((p) => p.uniqName) },
      });
    }

    if (connected.length === 0) {
      this.logger.error('Unable to connect to any mempool providers', {
        module: this.moduleName,
      });
      throw new Error('Unable to connect to any mempool providers');
    }
    this.logger.log(`Mempool connected providers: ${connected.map((p) => p.uniqName).join(', ')}`);
  }

  protected async getHealthyProviders(): Promise<MempoolProvider[]> {
    const result: MempoolProvider[] = [];
    for (const provider of this.providers.values()) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (healthy) result.push(provider);
    }
    return result;
  }

  /**
   * Runtime entry point — returns null on any failure instead of throwing.
   * Caller receives null and decides what to do (retry, skip, etc.).
   */
  async executeWithStrategy<T>(
    operation: (provider: MempoolProvider) => Promise<T>,
    options: MempoolRequestOptions = {}
  ): Promise<T> {
    const { strategy = 'round-robin', providerName, timeout = 30000 } = options;

    switch (strategy) {
      case 'single':
        return await this.executeSingle(operation, providerName);
      case 'parallel':
        return await this.executeParallel(operation, timeout);
      case 'fastest':
        return await this.executeFastest(operation, timeout);
      case 'round-robin':
      default:
        return await this.executeRoundRobin(operation);
    }
  }

  private async executeSingle<T>(
    operation: (provider: MempoolProvider) => Promise<T>,
    providerName: string = ''
  ): Promise<T> {
    const provider = await this.getProviderByName(providerName);
    return await operation(provider);
  }

  private async executeParallel<T>(operation: (provider: MempoolProvider) => Promise<T>, timeout: number): Promise<T> {
    const healthy = await this.getHealthyProviders();
    const tasks = healthy.map((provider) =>
      Promise.race([
        operation(provider),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operation timeout')), timeout)),
      ])
    );

    return await firstFulfilled(tasks);
  }

  private async executeFastest<T>(operation: (provider: MempoolProvider) => Promise<T>, timeout: number): Promise<T> {
    return this.executeParallel(operation, timeout);
  }

  private async executeRoundRobin<T>(operation: (provider: MempoolProvider) => Promise<T>): Promise<T> {
    const healthy = await this.getHealthyProviders();
    if (healthy.length === 0) throw new Error('No healthy mempool providers available');

    const first = healthy[this.currentProviderIndex % healthy.length]!;
    this.currentProviderIndex = (this.currentProviderIndex + 1) % healthy.length;

    try {
      return await operation(first);
    } catch (firstError) {
      // If there is only one healthy provider, retrying it makes no sense
      if (healthy.length < 2) throw firstError;

      this.logger.verbose(`Mempool provider "${first.uniqName}" failed in round-robin, trying next`, {
        module: this.moduleName,
        args: { error: (firstError as any)?.message },
      });

      const second = healthy[this.currentProviderIndex % healthy.length]!;
      this.currentProviderIndex = (this.currentProviderIndex + 1) % healthy.length;

      return await operation(second);
    }
  }

  async executeOnMultiple<T>(
    operation: (provider: MempoolProvider) => Promise<T>,
    options: MempoolRequestOptions = {}
  ): Promise<Array<{ providerName: string; value: T }>> {
    const { timeout = 30000 } = options;
    const healthy = await this.getHealthyProviders();
    if (healthy.length === 0) {
      this.logger.error('No healthy mempool providers available for multiple execution', {
        module: this.moduleName,
      });
      return [];
    }

    const results = await Promise.allSettled(
      healthy.map(async (provider) => {
        try {
          const value = await Promise.race([
            operation(provider),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operation timeout')), timeout)),
          ]);
          return { ok: true as const, providerName: provider.uniqName, value: value as T };
        } catch (e) {
          this.logger.debug(`Mempool provider "${provider.uniqName}" failed in multiple execution`, {
            module: this.moduleName,
            args: { error: (e as any)?.message },
          });
          return { ok: false as const, providerName: provider.uniqName };
        }
      })
    );

    const out: Array<{ providerName: string; value: T }> = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        out.push({ providerName: r.value.providerName, value: r.value.value as T });
      }
    }

    if (out.length === 0) {
      this.logger.error('All mempool providers failed in multiple execution', {
        module: this.moduleName,
        args: { providers: healthy.map((p) => p.uniqName) },
      });
    }

    return out;
  }

  async getProviderStats(): Promise<{ total: number; healthy: number; failed: number }> {
    const total = this.providers.size;
    const healthyProviders = await this.getHealthyProviders();
    return { total, healthy: healthyProviders.length, failed: total - healthyProviders.length };
  }
}
