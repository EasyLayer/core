import { Injectable } from '@nestjs/common';
import { ConnectionManager } from './connection-manager';

@Injectable()
export class WebhookStreamService {
  constructor(private readonly _connectionManager: ConnectionManager) {}

  get connectionManager() {
    return this._connectionManager;
  }

  async handleStream(streamConfig: any): Promise<NodeJS.ReadWriteStream> {
    const provider = await this._connectionManager.getActiveProvider();
    return provider.handleWebhookStream(streamConfig);
  }

  public async createStream(streamConfig: any): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    const stream = await provider.createWebhookStream(streamConfig);
    return {
      ...stream,
      providerName: provider.uniqName,
    };
  }

  public async destroyStream(streamId: string, providerName: string): Promise<void> {
    const provider = await this._connectionManager.getProviderByName(providerName);
    return await provider.createWebhookStream(streamId);
  }
}
