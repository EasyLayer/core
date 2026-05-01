import { BaseConnectionManager, type ManagedProvider } from './base.manager';
import type { UniversalTransaction } from '../providers/interfaces';

export interface EvmMempoolProvider extends ManagedProvider {
  hasWebSocketSupport?: boolean;
  isWebSocketConnected?: boolean;
  subscribeToPendingTransactions(callback: (txHash: string) => void): { unsubscribe(): void };
  getRawMempool(): Promise<Record<string, any>>;
  getTransactionByHash(hash: string): Promise<UniversalTransaction | null>;
}

export class MempoolConnectionManager<
  T extends EvmMempoolProvider = EvmMempoolProvider,
> extends BaseConnectionManager<T> {
  private activeProviderName = '';
  private _isAvailable = false;

  get isAvailable(): boolean {
    return this._isAvailable;
  }

  async initialize(): Promise<void> {
    if (this.providers.size === 0) {
      this.logger.log?.('No EVM mempool providers configured — mempool disabled', { module: this.moduleName } as any);
      return;
    }

    const { connected } = await this.ensureConnectedAll();
    for (const provider of connected) {
      const healthy = await provider.healthcheck().catch(() => false);
      if (!healthy) continue;
      this.activeProviderName = provider.uniqName;
      this._isAvailable = true;
      return;
    }

    this._isAvailable = false;
    this.logger.warn?.('No EVM mempool providers could connect — mempool disabled', { module: this.moduleName } as any);
  }

  getActiveProvider(): T | null {
    if (!this._isAvailable) return null;
    return this.providers.get(this.activeProviderName) ?? null;
  }
}
