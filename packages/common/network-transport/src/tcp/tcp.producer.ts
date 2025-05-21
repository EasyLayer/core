import { firstValueFrom } from 'rxjs';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer } from '../base-producer';
import { OutgoingMessage, DefaultOutgoingActions } from '../interfaces';

export type TcpOutgoingActions = DefaultOutgoingActions;
export type TcpMessagePayload = any; // TODO

export type TcpOutgoingMessage = OutgoingMessage<TcpOutgoingActions, TcpMessagePayload> & {};

@Injectable()
export class TcpProducer extends BaseProducer<TcpOutgoingMessage> implements OnModuleDestroy {
  private client: ClientProxy;
  private _timer: ExponentialTimer | null = null;
  private lastPongTime = 0;

  constructor(
    private readonly log: AppLogger,
    { host, port }: { host: string; port: number }
  ) {
    super();
    this.client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host,
        port,
      },
    });

    // IMPORTANT: Ping sends constantly and regardless.
    this.log.debug('Starting ping to clients via TCP');
    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.sendPing();
        } catch (error) {
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

  onModuleDestroy(): void {
    this.log.debug('Stopping ping interval on module destroy');
    this._timer?.destroy();
    this._timer = null;
    this.client?.close();
  }

  /**
   * Sends a ping message
   */
  private async sendPing(): Promise<void> {
    const msg = { action: 'ping', payload: {} };
    await firstValueFrom(this.client.emit<void, typeof msg>('message', msg));
  }

  /**
   * Mark a received pong.
   */
  public markPong(): void {
    this.lastPongTime = Date.now();
  }

  /**
   * Validates TCP connection is alive.
   * @param timeoutMs Maximum time in ms since last pong
   */
  public isConnected(timeoutMs = 10000): boolean {
    return Date.now() - this.lastPongTime < timeoutMs;
  }

  /**
   * Send a message if connection is alive.
   */
  public async sendMessage(message: TcpOutgoingMessage): Promise<void> {
    // IMPORTANT: If there is no connection now, we immediately throw an error (and do not wait for a timeout),
    // this is because we have a commit method that should immediately understand whether the message was sent or not.
    if (!this.isConnected()) {
      throw new Error('TCP connection lost');
    }

    const tcpMsg = {
      ...message,
    };

    this.log.debug('Attempting to send TCP message', { args: { tcpMsg } });

    await this.client.emit('messages', tcpMsg).toPromise();
  }
}
