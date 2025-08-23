import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AppLogger } from '@easylayer/common/logger';
import type { ProducerConfig } from '../../core';
import { BaseProducer } from '../../core';

/**
 * WebSocket producer:
 * - Sends serialized envelopes only to the single registered streaming client.
 * - "Connected" means we have that socket AND a fresh Pong within heartbeatTimeoutMs.
 * - Heartbeat/retries: BaseProducer.startRetryTimerIfNeeded() (exponential).
 * Memory: one serialized string per message; O(n) over payload size.
 */
export class WsProducer extends BaseProducer {
  private server: SocketIOServer | null = null;
  private streamingClientId: string | null = null;

  constructor(log: AppLogger, cfg: ProducerConfig) {
    super(log, cfg);
  }

  public setServer(server: SocketIOServer) {
    this.server = server;
    this.startRetryTimerIfNeeded();
  }

  public setStreamingClient(id: string | null) {
    this.streamingClientId = id;
  }

  public getStreamingClient(): Socket | null {
    if (!this.server || !this.streamingClientId) return null;
    const sock = (this.server.sockets as any).sockets?.get(this.streamingClientId);
    return sock ?? null;
  }

  protected _isUnderlyingConnected(): boolean {
    return !!this.getStreamingClient();
  }

  protected async _sendSerialized(serialized: string): Promise<void> {
    const client = this.getStreamingClient();
    if (!client) throw new Error('[ws] no streaming client connected');
    client.emit('message', serialized); // client parses JSON
  }

  /** Called by gateway when a Pong arrives from the current client. */
  public onClientPong(): void {
    this.onPong(Date.now());
  }
}
