import type { BaseTransport } from '../transports';
import type { NetworkConfig } from '../transports';

export abstract class BaseProvider {
  protected _transport: BaseTransport;
  protected network: NetworkConfig;

  constructor(transport: BaseTransport) {
    this._transport = transport;
    this.network = transport.network;
  }

  get transport(): BaseTransport {
    return this._transport;
  }

  get uniqName(): string {
    return this._transport.uniqName;
  }

  get type(): string {
    return this._transport.type;
  }

  get connectionOptions() {
    return this._transport.connectionOptions;
  }

  // Connection management delegated to transport
  async connect(): Promise<void> {
    return this._transport.connect();
  }

  async disconnect(): Promise<void> {
    return this._transport.disconnect();
  }

  async healthcheck(): Promise<boolean> {
    return this._transport.healthcheck();
  }

  /**
   * Handle provider failures - used by connection managers
   */
  async handleConnectionError(error: any, methodName: string): Promise<void> {
    throw error; // Re-throw to let connection manager handle provider switching
  }
}
