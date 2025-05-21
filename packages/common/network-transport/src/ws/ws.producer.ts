import type { Server } from 'socket.io';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer } from '../base-producer';
import { OutgoingMessage, DefaultOutgoingActions } from '../interfaces';

export type WsOutgoingActions = DefaultOutgoingActions;
export type WsMessagePayload = any; // TODO

export type WsOutgoingMessage = OutgoingMessage<WsOutgoingActions, WsMessagePayload> & {};

@Injectable()
export class WsProducer extends BaseProducer<WsOutgoingMessage> implements OnModuleDestroy {
  private lastPongTime = 0;

  constructor(private readonly log: AppLogger) {
    super();
  }

  public async sendPing(server: Server): Promise<void> {
    const msg = { action: 'ping', payload: {} };
    server.emit('message', msg);
  }

  // public startPing(server: Server) {
  //   const interval = 2000;
  //   this.log.debug('Starting ping to clients via Ws', { args: { interval } });
  //   server.emit('messages', { action: 'ping', payload: {} });
  //   this.pingInterval = setInterval(() => {
  //     server.emit('messages', { action: 'ping', payload: {} });
  //   }, interval);
  // }

  async onModuleDestroy() {}

  /**
   * Mark a received pong.
   */
  public markPong(): void {
    this.lastPongTime = Date.now();
  }

  /**
   * Validates WS connection is alive.
   * @param timeoutMs Maximum time in ms since last pong
   */
  public isConnected(timeoutMs = 10000): boolean {
    return Date.now() - this.lastPongTime < timeoutMs;
  }

  /**
   * Send a message if connection is alive.
   */
  public async sendMessage(message: WsOutgoingMessage, server: Server): Promise<void> {
    // IMPORTANT: If there is no connection now, we immediately throw an error (and do not wait for a timeout),
    // this is because we have a commit method that should immediately understand whether the message was sent or not.
    if (!this.isConnected()) {
      throw new Error('TCP connection lost');
    }

    const wsMsg = {
      ...message,
    };

    this.log.debug('Attempting to send WS message', { args: { wsMsg } });

    server.emit('messages', wsMsg);
  }
}
