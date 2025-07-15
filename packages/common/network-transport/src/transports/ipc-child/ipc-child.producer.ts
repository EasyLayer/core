import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer } from '../../core/base-producer';
import {
  OutgoingMessage,
  ClientNotFoundError,
  MESSAGE_SIZE_LIMITS,
  ConnectionError,
  validateMessageSize,
} from '../../shared';
import type { IpcServerOptions } from './ipc-child.module';

interface IpcOutgoingMessage extends OutgoingMessage {
  correlationId: string;
}

@Injectable()
export class IpcChildProducer extends BaseProducer<OutgoingMessage> implements OnModuleDestroy {
  private lastPongTime = 0;
  private _timer: ExponentialTimer | null = null;
  private readonly maxMessageSize: number;
  private readonly heartbeatTimeout: number;

  constructor(
    private readonly log: AppLogger,
    @Inject('IPC_OPTIONS')
    private readonly options: IpcServerOptions
  ) {
    super();

    if (!process.send) {
      throw new Error('IpcProducer must run in a child process with IPC');
    }

    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.IPC;
    this.heartbeatTimeout = options.heartbeatTimeout ?? 10000;

    this.log.info('IPC producer initialized', {
      args: {
        pid: process.pid,
        ppid: process.ppid,
        connected: process.connected,
        maxMessageSize: this.maxMessageSize,
        heartbeatTimeout: this.heartbeatTimeout,
      },
    });

    // Start ping timer
    this.log.debug('Starting ping to parent process via IPC');
    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.sendPing();
        } catch (error) {
          this.log.debug('Error sending IPC ping, resetting interval', {
            args: { error: (error as Error).message },
          });
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
    this.log.debug('Stopping IPC ping interval on module destroy');
    this._timer?.destroy();
    this._timer = null;
  }

  /**
   * Sends a ping message to parent process
   */
  public async sendPing(): Promise<void> {
    if (!process.send) {
      throw new ClientNotFoundError('process.send is not available');
    }

    if (!process.connected) {
      throw new ClientNotFoundError('Process is not connected to parent');
    }

    const msg: OutgoingMessage = {
      action: 'ping',
      payload: {},
      timestamp: Date.now(),
    };

    const ipcMsg = this.createIpcMessage(msg);
    validateMessageSize(ipcMsg, this.maxMessageSize, 'ipc');

    await new Promise<void>((resolve, reject) => {
      process.send!(ipcMsg, (err: Error | null) => {
        if (err) {
          this.log.debug('Failed to send IPC ping', {
            args: {
              error: err.message,
              pid: process.pid,
              connected: process.connected,
            },
          });
          return reject(
            new ConnectionError('Failed to send IPC ping', {
              transportType: 'ipc',
              cause: err,
            })
          );
        }
        resolve();
      });
    });

    this.log.debug('IPC ping sent to parent process', {
      args: { pid: process.pid, connected: process.connected },
    });
  }

  /**
   * Validates IPC connection is alive.
   * @param timeoutMs Maximum time in ms since last pong
   */
  public isConnected(timeoutMs?: number): boolean {
    const timeout = timeoutMs ?? this.heartbeatTimeout;
    const connected = process.connected && Date.now() - this.lastPongTime < timeout;

    if (!connected && process.connected) {
      this.log.debug('IPC connection appears stale', {
        args: {
          timeSinceLastPong: Date.now() - this.lastPongTime,
          timeoutMs: timeout,
          pid: process.pid,
          connected: process.connected,
        },
      });
    }

    return connected;
  }

  /**
   * Marks reception of pong from parent.
   */
  public markPong(): void {
    this.lastPongTime = Date.now();
    this.log.debug('IPC pong received from parent process', {
      args: { pid: process.pid, connected: process.connected },
    });
  }

  /**
   * Sends a message to the parent process, throwing if disconnected.
   */
  async sendMessage(message: OutgoingMessage, options?: { correlationId?: string }): Promise<void> {
    if (!process.send) {
      throw new ClientNotFoundError('process.send is not available');
    }

    if (!process.connected) {
      throw new ClientNotFoundError('Process is not connected to parent');
    }

    const ipcMsg = this.createIpcMessage(message, options?.correlationId);
    validateMessageSize(ipcMsg, this.maxMessageSize, 'ipc');

    // For broadcast events, immediately check connection status
    if (message.action === 'eventsBatch' || message.action === 'event') {
      if (!this.isConnected()) {
        throw new ClientNotFoundError('IPC connection lost - cannot broadcast events');
      }

      this.log.debug('Broadcasting IPC message', {
        args: {
          action: message.action,
          correlationId: ipcMsg.correlationId,
          pid: process.pid,
        },
      });

      return new Promise<void>((resolve, reject) => {
        process.send!(ipcMsg, (err: any) => {
          if (err) {
            this.log.debug('Failed to broadcast IPC message', {
              args: {
                error: err.message,
                pid: process.pid,
                connected: process.connected,
              },
            });
            reject(
              new ConnectionError('Failed to broadcast IPC message', {
                transportType: 'ipc',
                cause: err,
              })
            );
          } else {
            resolve();
          }
        });
      });
    }

    // For responses, check connection status
    if (!this.isConnected()) {
      throw new ClientNotFoundError('IPC connection lost');
    }

    this.log.debug('Sending IPC message', {
      args: {
        action: message.action,
        correlationId: ipcMsg.correlationId,
        requestId: message.requestId,
        pid: process.pid,
      },
    });

    return new Promise<void>((resolve, reject) => {
      process.send!(ipcMsg, (err: any) => {
        if (err) {
          this.log.error('Failed to send IPC message', {
            args: {
              error: err.message,
              pid: process.pid,
              connected: process.connected,
            },
          });
          reject(
            new ConnectionError('Failed to send IPC message', {
              transportType: 'ipc',
              cause: err,
            })
          );
        } else {
          resolve();
        }
      });
    });
  }

  private createIpcMessage(message: OutgoingMessage, correlationId?: string): IpcOutgoingMessage {
    return {
      ...message,
      correlationId: correlationId || `${process.pid}:${Date.now()}:${Math.random()}`,
    };
  }
}
