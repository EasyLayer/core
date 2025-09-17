import type { Logger } from '@nestjs/common';

export interface BaseConnectionManagerOptions<T> {
  providers: T[];
  logger: Logger;
}

/**
 * A minimal base that knows how to:
 * - register providers
 * - perform idempotent connects
 * - disconnect and cleanup
 * It does NOT define initialization or failover policies.
 */
export abstract class BaseConnectionManager<
  T extends {
    uniqName: string;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    healthcheck(): Promise<boolean>;
  },
> {
  protected providers: Map<string, T> = new Map();
  protected logger: Logger;
  protected connected: Set<string> = new Set();

  constructor(options: BaseConnectionManagerOptions<T>) {
    this.logger = options.logger;

    for (const provider of options.providers) {
      const name = provider.uniqName;
      if (this.providers.has(name)) {
        throw new Error(`A provider with the name "${name}" has already been added.`);
      }
      this.providers.set(name, provider);
      this.logger.debug('Provider registered', {
        args: { providerName: name, providerType: (provider as any)?.type },
      });
    }
  }

  get allProviders(): T[] {
    return Array.from(this.providers.values());
  }

  /**
   * Idempotent connect for a single provider.
   */
  protected async ensureConnected(provider: T): Promise<boolean> {
    if (this.connected.has(provider.uniqName)) return true;
    try {
      await provider.connect();
      this.connected.add(provider.uniqName);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Idempotent connect for all providers; subclasses decide how to interpret failures.
   */
  protected async ensureConnectedAll(): Promise<{ connected: T[]; failed: T[] }> {
    const connected: T[] = [];
    const failed: T[] = [];
    for (const provider of this.providers.values()) {
      const ok = await this.ensureConnected(provider);
      if (ok) connected.push(provider);
      else failed.push(provider);
    }
    return { connected, failed };
  }

  /**
   * Full cleanup of all providers.
   */
  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      this.logger.debug('Disconnecting provider', { args: { providerName: provider.uniqName } });
      try {
        await provider.disconnect();
      } catch (error) {
        this.logger.warn('Error disconnecting provider during cleanup', {
          args: { error, providerName: provider.uniqName },
        });
      } finally {
        this.connected.delete(provider.uniqName);
      }
    }
  }

  async getProviderByName(name: string): Promise<T> {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Provider with name ${name} not found`);
    return provider;
  }

  async removeProvider(name: string): Promise<boolean> {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Provider with name ${name} not found`);
    try {
      await provider.disconnect();
    } catch (error) {
      this.logger.error('Error disconnecting provider during removal', { args: { error, name } });
    } finally {
      this.connected.delete(name);
    }
    return this.providers.delete(name);
  }

  getConnectionOptionsForAllProviders(): any[] {
    const options: any[] = [];
    for (const provider of this.providers.values()) {
      options.push((provider as any)?.connectionOptions);
    }
    return options;
  }
}
