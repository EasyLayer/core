import type { BaseTransport, NetworkConfig } from '../transports';

export abstract class BaseProvider {
  protected _transport: BaseTransport;
  protected network: NetworkConfig;

  constructor(transport: BaseTransport) {
    this._transport = transport;
    this.network = transport.network;
  }

  protected get transport(): BaseTransport {
    return this._transport;
  }

  /** Read-only transport type for routers/managers */
  public get transportType(): string {
    return (this._transport as any).type;
  }

  get uniqName(): string {
    return this._transport.uniqName;
  }

  async connect(): Promise<void> {
    return this._transport.connect();
  }

  async disconnect(): Promise<void> {
    return this._transport.disconnect();
  }

  async healthcheck(): Promise<boolean> {
    return this._transport.healthcheck();
  }
}
