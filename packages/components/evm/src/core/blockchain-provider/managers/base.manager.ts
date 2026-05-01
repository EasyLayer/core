import type { Logger } from '@nestjs/common';

export interface ManagedProvider {
  uniqName: string;
  type?: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthcheck(): Promise<boolean>;
}

export interface BaseConnectionManagerOptions<T extends ManagedProvider> {
  providers: T[];
  logger: Logger;
}

/**
 * Shared provider registry/connection lifecycle for EVM managers.
 * Network/mempool managers decide their own failover and availability policies.
 */
export abstract class BaseConnectionManager<T extends ManagedProvider> {
  protected readonly moduleName = 'blockchain-provider';
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
      this.logger.verbose?.('Provider registered', {
        module: this.moduleName,
        args: { providerName: name, providerType: provider.type },
      } as any);
    }
  }

  get allProviders(): T[] {
    return Array.from(this.providers.values());
  }

  protected async ensureConnected(provider: T): Promise<boolean> {
    if (this.connected.has(provider.uniqName)) return true;
    try {
      await provider.connect();
      this.connected.add(provider.uniqName);
      return true;
    } catch (error) {
      this.logger.verbose?.('Provider connection attempt failed', {
        module: this.moduleName,
        args: { providerName: provider.uniqName, action: 'connect', error: (error as Error).message },
      } as any);
      return false;
    }
  }

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

  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      try {
        await provider.disconnect();
      } catch (error) {
        this.logger.verbose?.('Error disconnecting provider during cleanup', {
          module: this.moduleName,
          args: { providerName: provider.uniqName, action: 'destroy', error },
        } as any);
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
    } finally {
      this.connected.delete(name);
    }
    return this.providers.delete(name);
  }

  getConnectionOptionsForAllProviders(): any[] {
    return Array.from(this.providers.values()).map((provider: any) => provider?.connectionOptions);
  }
}
