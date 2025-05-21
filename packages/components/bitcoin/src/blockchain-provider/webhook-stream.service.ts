import { Injectable } from '@nestjs/common';
import { ConnectionManager } from './connection-manager';

/**
 * Service responsible for managing webhook streams via configured providers.
 * Delegates operations to the active provider retrieved from ConnectionManager.
 *
 * @remarks
 * Provides methods to create, handle, and destroy webhook streams seamlessly.
 */
@Injectable()
export class WebhookStreamService {
  /**
   * Initializes the WebhookStreamService with a ConnectionManager instance.
   *
   * @param _connectionManager - The manager responsible for provider connections.
   */
  constructor(private readonly _connectionManager: ConnectionManager) {}

  /**
   * Retrieves the ConnectionManager instance.
   *
   * @returns The current ConnectionManager.
   */
  get connectionManager(): ConnectionManager {
    return this._connectionManager;
  }

  /**
   * Handles an incoming webhook stream by delegating to the active provider.
   *
   * @param streamConfig - Configuration object for the webhook stream.
   * @returns A ReadWriteStream to consume the webhook payload.
   */
  async handleStream(streamConfig: any): Promise<NodeJS.ReadWriteStream> {
    const provider = await this._connectionManager.getActiveProvider();
    return provider.handleWebhookStream(streamConfig);
  }

  /**
   * Creates a new webhook stream with the active provider.
   *
   * @param streamConfig - Configuration object for the new webhook stream.
   * @returns An object containing stream details and the provider's unique name.
   */
  public async createStream(streamConfig: any): Promise<any> {
    const provider = await this._connectionManager.getActiveProvider();
    const stream = await provider.createWebhookStream(streamConfig);
    return {
      ...stream,
      providerName: provider.uniqName,
    };
  }

  /**
   * Destroys an existing webhook stream by delegating to the specified provider.
   *
   * @param providerName - Unique name of the provider managing the stream.
   */
  public async destroyStream(providerName: string): Promise<void> {
    const provider = await this._connectionManager.getProviderByName(providerName);
    await provider.destroyWebhookStream();
  }
}
