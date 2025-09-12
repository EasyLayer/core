import type { MempoolProvider } from '../providers';
import { BaseConnectionManager } from './base.manager';

export type MempoolRequestStrategy = 'parallel' | 'round-robin' | 'fastest' | 'single';

export interface MempoolRequestOptions {
  strategy?: MempoolRequestStrategy;
  providerName?: string;
  timeout?: number;
}

/**
 * Multi-provider strategy:
 * - Connect all providers
 * - No automatic switching inside manager; strategies drive usage
 * - Recovery delegates to per-call handling
 */
export class MempoolConnectionManager extends BaseConnectionManager<MempoolProvider> {
  private currentProviderIndex = 0;

  async initialize(): Promise<void> {
    const { connected } = await this.ensureConnectedAll();
    if (connected.length === 0) {
      throw new Error('Unable to connect to any mempool providers');
    }
    this.logger.info(`Mempool connected providers: ${connected.map((p) => p.uniqName).join(', ')}`);
  }

  protected async getHealthyProviders(): Promise<MempoolProvider[]> {
    const result: MempoolProvider[] = [];
    for (const provider of this.providers.values()) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (healthy) result.push(provider);
    }
    return result;
  }

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
    providerName?: string
  ): Promise<T> {
    if (!providerName) throw new Error('Provider name is required for single strategy');
    const provider = await this.getProviderByName(providerName);
    try {
      return await operation(provider);
    } catch (error) {
      throw new Error(`Provider ${provider.uniqName} failed: ${(error as any)?.message ?? error}`);
    }
  }

  private async executeParallel<T>(operation: (provider: MempoolProvider) => Promise<T>, timeout: number): Promise<T> {
    const healthy = await this.getHealthyProviders();
    if (healthy.length === 0) throw new Error('No healthy providers available for parallel execution');

    const tasks = healthy.map((provider) =>
      Promise.race([
        operation(provider),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operation timeout')), timeout)),
      ])
    );

    try {
      return await Promise.any(tasks);
    } catch {
      throw new Error('All parallel operations failed');
    }
  }

  private async executeFastest<T>(operation: (provider: MempoolProvider) => Promise<T>, timeout: number): Promise<T> {
    return this.executeParallel(operation, timeout);
  }

  private async executeRoundRobin<T>(operation: (provider: MempoolProvider) => Promise<T>): Promise<T> {
    const healthy = await this.getHealthyProviders();
    if (healthy.length === 0) throw new Error('No healthy providers available for round-robin execution');

    const first = healthy[this.currentProviderIndex % healthy.length]!;
    this.currentProviderIndex = (this.currentProviderIndex + 1) % healthy.length;

    try {
      return await operation(first);
    } catch {
      const second = healthy[this.currentProviderIndex % healthy.length]!;
      this.currentProviderIndex = (this.currentProviderIndex + 1) % healthy.length;
      return await operation(second);
    }
  }

  async executeOnMultiple<T>(
    operation: (provider: MempoolProvider) => Promise<T>,
    options: MempoolRequestOptions = {}
  ): Promise<T[]> {
    const { timeout = 30000 } = options;
    const healthy = await this.getHealthyProviders();
    if (healthy.length === 0) throw new Error('No healthy providers available for multiple execution');

    const results = await Promise.allSettled(
      healthy.map((provider) =>
        Promise.race([
          operation(provider),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operation timeout')), timeout)),
        ])
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => {
            this.logger.warn('Provider operation failed in multiple execution', {
              args: { providerName: provider.uniqName, error: (e as any)?.message },
            });
            return { ok: false as const };
          })
      )
    );

    const values: T[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) values.push(r.value.v as T);
    }
    if (values.length === 0) throw new Error('All providers failed in multiple execution');
    return values;
  }

  getProviderStats(): { total: number; healthy: number; failed: number } {
    const total = this.providers.size;
    // No global failed tracking here; health is dynamic per-request
    return { total, healthy: total, failed: 0 };
  }
}
