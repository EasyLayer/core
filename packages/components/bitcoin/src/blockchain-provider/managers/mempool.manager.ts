import type { MempoolProvider } from '../providers';
import { BaseConnectionManager } from './base.manager';

export type MempoolRequestStrategy = 'parallel' | 'round-robin' | 'fastest' | 'single';

export interface MempoolRequestOptions {
  strategy?: MempoolRequestStrategy;
  providerName?: string; // For 'single' strategy
  timeout?: number;
}

export class MempoolConnectionManager extends BaseConnectionManager<MempoolProvider> {
  private currentProviderIndex = 0;

  /**
   * Handle provider switching for multiple provider strategy
   */
  protected async handleProviderSwitching(failedProvider: MempoolProvider): Promise<MempoolProvider> {
    // For mempool, we don't switch - we return the failed provider
    // The service layer will handle retries and strategies
    throw new Error(`Provider ${failedProvider.uniqName} failed and requires service-level handling`);
  }

  /**
   * Get all healthy providers
   */
  async getHealthyProviders(): Promise<MempoolProvider[]> {
    const healthyProviders: MempoolProvider[] = [];

    for (const provider of this.providers.values()) {
      try {
        if (await provider.healthcheck()) {
          healthyProviders.push(provider);
        }
      } catch (error) {
        // Provider not healthy, skip
      }
    }

    return healthyProviders;
  }

  /**
   * Execute operation with specified strategy
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

  /**
   * Execute on single specified provider
   */
  private async executeSingle<T>(
    operation: (provider: MempoolProvider) => Promise<T>,
    providerName?: string
  ): Promise<T> {
    if (!providerName) {
      throw new Error('Provider name is required for single strategy');
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} not found`);
    }

    try {
      return await operation(provider);
    } catch (error) {
      // Attempt recovery through base class
      const recoveredProvider = await this.handleProviderFailure(providerName, error, 'executeSingle');
      return await operation(recoveredProvider);
    }
  }

  /**
   * Execute on all providers in parallel, return first successful result
   */
  private async executeParallel<T>(operation: (provider: MempoolProvider) => Promise<T>, timeout: number): Promise<T> {
    const healthyProviders = await this.getHealthyProviders();

    if (healthyProviders.length === 0) {
      throw new Error('No healthy providers available for parallel execution');
    }

    const promises = healthyProviders.map(async (provider) => {
      try {
        return await Promise.race([
          operation(provider),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operation timeout')), timeout)),
        ]);
      } catch (error) {
        throw new Error(`Provider ${provider.uniqName} failed: ${error}`);
      }
    });

    try {
      return await Promise.any(promises);
    } catch (error) {
      throw new Error('All parallel operations failed');
    }
  }

  /**
   * Execute on all providers, return fastest successful result
   */
  private async executeFastest<T>(operation: (provider: MempoolProvider) => Promise<T>, timeout: number): Promise<T> {
    const healthyProviders = await this.getHealthyProviders();

    if (healthyProviders.length === 0) {
      throw new Error('No healthy providers available for fastest execution');
    }

    // Same as parallel for now, but could be enhanced with provider performance tracking
    return await this.executeParallel(operation, timeout);
  }

  /**
   * Execute using round-robin provider selection
   */
  private async executeRoundRobin<T>(operation: (provider: MempoolProvider) => Promise<T>): Promise<T> {
    const healthyProviders = await this.getHealthyProviders();

    if (healthyProviders.length === 0) {
      throw new Error('No healthy providers available for round-robin execution');
    }

    // Select next provider in round-robin fashion
    const provider = healthyProviders[this.currentProviderIndex % healthyProviders.length]!;
    this.currentProviderIndex = (this.currentProviderIndex + 1) % healthyProviders.length;

    try {
      return await operation(provider);
    } catch (error) {
      // Try next provider in round-robin
      const nextProvider = healthyProviders[this.currentProviderIndex % healthyProviders.length]!;
      this.currentProviderIndex = (this.currentProviderIndex + 1) % healthyProviders.length;

      try {
        return await operation(nextProvider);
      } catch (secondError) {
        // If second attempt also fails, attempt recovery
        try {
          const recoveredProvider = await this.handleProviderFailure(provider.uniqName, error, 'executeRoundRobin');
          return await operation(recoveredProvider);
        } catch (recoveryError) {
          throw new Error('Round-robin execution failed on all attempts');
        }
      }
    }
  }

  /**
   * Execute operation on multiple providers and combine results
   */
  async executeOnMultiple<T>(
    operation: (provider: MempoolProvider) => Promise<T>,
    options: MempoolRequestOptions = {}
  ): Promise<T[]> {
    const { timeout = 30000 } = options;
    const healthyProviders = await this.getHealthyProviders();

    if (healthyProviders.length === 0) {
      throw new Error('No healthy providers available for multiple execution');
    }

    const promises = healthyProviders.map(async (provider): Promise<T | null> => {
      try {
        const result = await Promise.race([
          operation(provider),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operation timeout')), timeout)),
        ]);
        return result;
      } catch (error) {
        this.logger.warn('Provider operation failed in multiple execution', {
          args: { providerName: provider.uniqName, error: (error as any)?.message },
        });
        return null; // Return null for failed operations
      }
    });

    const results = await Promise.allSettled(promises);
    const successfulResults: T[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        successfulResults.push(result.value);
      }
    }

    if (successfulResults.length === 0) {
      throw new Error('All providers failed in multiple execution');
    }

    return successfulResults;
  }

  /**
   * Get provider statistics
   */
  getProviderStats(): { total: number; healthy: number; failed: number } {
    const total = this.providers.size;
    const failed = this.failedProviders.size;
    const healthy = total - failed;

    return { total, healthy, failed };
  }

  /**
   * Reset provider failure state
   */
  resetFailureState(): void {
    this.failedProviders.clear();
    this.reconnectionAttempts.clear();
  }
}
