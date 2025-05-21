import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { BaseProducer } from '../base-producer';
import { OutgoingMessage, DefaultOutgoingActions } from '../interfaces';

export type IpcOutgoingActions = DefaultOutgoingActions;
export type IpcMessagePayload = any; // TODO

export type IpcOutgoingMessage = OutgoingMessage<IpcOutgoingActions, IpcMessagePayload> & {};

@Injectable()
export class IpcChildProducer extends BaseProducer<IpcOutgoingMessage> implements OnModuleDestroy {
  private lastPongTime = 0;
  private _timer: ExponentialTimer | null = null;

  constructor(private readonly log: AppLogger) {
    super();

    // IMPORTANT: Ping sends constantly and regardless.
    this.log.debug('Starting ping to clients via IPC');
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
  }

  /**
   * Sends a ping message
   */
  private async sendPing(): Promise<void> {
    const msg = { action: 'ping', correlationId: `${Date.now()}:${Math.random()}`, payload: {} };

    await new Promise<void>((resolve, reject) => {
      // process.send returns boolean synchronously, but the callback itself is asynchronous
      process.send!(msg, (err: Error | null) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * Validates IPC connection is alive.
   * @param timeoutMs Maximum time in ms since last pong
   */
  public isConnected(timeoutMs = 10000): boolean {
    return process.connected && Date.now() - this.lastPongTime < timeoutMs;
  }

  /**
   * Marks reception of pong from parent.
   */
  public markPong(): void {
    this.lastPongTime = Date.now();
  }

  /**
   * Sends a message to the parent process, throwing if disconnected.
   */
  async sendMessage(message: OutgoingMessage, options?: { correlationId?: string }): Promise<void> {
    // IMPORTANT: If there is no connection now, we immediately throw an error (and do not wait for a timeout),
    // this is because we have a commit method that should immediately understand whether the message was sent or not.
    if (!this.isConnected()) {
      throw new Error('IPC connection lost');
    }

    const ipcMsg = {
      ...message,
      correlationId: options?.correlationId ? options.correlationId : `${Date.now()}:${Math.random()}`,
    };

    this.log.debug('Attempting to send TCP message', { args: { ipcMsg } });

    return new Promise<void>((resolve, reject) => {
      process.send!(ipcMsg, (err: any) => (err ? reject(err) : resolve()));
    });
  }
}
