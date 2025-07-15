import type { Server } from 'socket.io';
import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer } from '../../core/base-producer';
import { OutgoingMessage, ClientNotFoundError, MESSAGE_SIZE_LIMITS, validateMessageSize } from '../../shared';
import type { WsServerOptions } from './ws.module';

@Injectable()
export class WsProducer extends BaseProducer<OutgoingMessage> implements OnModuleDestroy {
  private lastPongTime = 0;
  private server: Server | null = null;
  private _timer: ExponentialTimer | null = null;
  private readonly maxMessageSize: number;
  private readonly heartbeatTimeout: number;

  constructor(
    private readonly log: AppLogger,
    @Inject('WS_OPTIONS')
    private readonly options: WsServerOptions
  ) {
    super();
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.WS;
    this.heartbeatTimeout = options.heartbeatTimeout ?? 10000;

    // Start ping timer
    this.log.debug('Starting ping to clients via WebSocket');
    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.sendPing();
        } catch (error) {
          // this.log.error('Error sending WebSocket ping', { args: { error } });
          resetInterval();
        }
      },
      {
        interval: 500,
        maxInterval: 3000,
        multiplier: 2,
      }
    );
  }

  setServer(server: Server) {
    this.server = server;
    this.lastPongTime = Date.now(); // Initialize connection time
    this.log.info('WebSocket server set and initialized');
  }

  public async sendPing(): Promise<void> {
    if (!this.server) {
      this.log.debug('No WebSocket server available for ping');
      return;
    }

    const msg: OutgoingMessage = {
      action: 'ping',
      payload: {},
      timestamp: Date.now(),
    };

    validateMessageSize(msg, this.maxMessageSize, 'ws');
    this.server.emit('message', msg);
    this.log.debug('WebSocket ping sent to all clients');
  }

  async onModuleDestroy() {
    this.log.debug('Stopping WebSocket producer');
    this._timer?.destroy();
    this._timer = null;
    this.server = null;
  }

  /**
   * Mark a received pong.
   */
  public markPong(): void {
    this.lastPongTime = Date.now();
    this.log.debug('WebSocket pong received from client');
  }

  /**
   * Validates WebSocket connection is alive.
   * @param timeoutMs Maximum time in ms since last pong
   */
  public isConnected(timeoutMs?: number): boolean {
    const timeout = timeoutMs ?? this.heartbeatTimeout;
    const connected = this.server !== null && Date.now() - this.lastPongTime < timeout;
    // if (!connected && this.server) {
    //   this.log.warn('WebSocket connection appears stale', {
    //     args: {
    //       timeSinceLastPong: Date.now() - this.lastPongTime,
    //       timeoutMs: timeout,
    //     },
    //   });
    // }
    return connected;
  }

  /**
   * Send a message if connection is alive.
   */
  public async sendMessage(message: OutgoingMessage, targetServer?: Server): Promise<void> {
    const server = targetServer || this.server;
    if (!server) {
      throw new ClientNotFoundError('WebSocket server not available');
    }

    validateMessageSize(message, this.maxMessageSize, 'ws');

    // IMPORTANT: For broadcast events, we immediately throw error if no connection
    // (and do not wait for a timeout), this is because we have a commit method
    // that should immediately understand whether the message was sent or not.
    if (message.action === 'eventsBatch' || message.action === 'event') {
      if (!this.isConnected()) {
        throw new ClientNotFoundError('WebSocket connection lost - cannot broadcast events');
      }

      this.log.debug('Broadcasting WebSocket message', {
        args: { action: message.action, hasPayload: !!message.payload },
      });
      server.emit('message', message);
      return;
    }

    // For responses, check connection
    if (!this.isConnected()) {
      throw new ClientNotFoundError('WebSocket connection lost');
    }

    this.log.debug('Sending WebSocket message', {
      args: { action: message.action, requestId: message.requestId },
    });
    server.emit('message', message);
  }
}
