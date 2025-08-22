import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer, BatchAckResult } from '../../core';
import {
  OutgoingMessage,
  MESSAGE_SIZE_LIMITS,
  validateMessageSize,
  ConnectionError,
  OutboxStreamBatchPayload,
} from '../../shared';
import type { IpcServerOptions } from './ipc-child.module';
import type { WireEventRecord } from '../../shared';
import { SecureChannel } from '../../shared';

/**
 * IPC Producer responsibilities:
 * - Start periodic PING (server → client) to let clients detect us on the bus.
 * - Consider itself "connected" **only after** first PONG (set by Consumer via markPong()).
 * - Send RPC responses via `sendMessage()`.
 * - Send outbox batches via `sendOutboxStreamBatchWithAck()` and wait for ACK that Consumer resolves.
 * - Apply secure channel wrapping for all outgoing frames (DH handshake state is driven by Consumer).
 *
 * NOTE:
 * - Producer does **NOT** subscribe to process.on('message'). Only Consumer listens inbound.
 * - Consumer calls Producer hooks: markPong(), resolveOutboxAck(), handleSecureHello(), finalizeSecure().
 */
@Injectable()
export class IpcChildProducer extends BaseProducer<OutgoingMessage> implements OnModuleDestroy {
  private lastPongTime = 0;
  private _timer: ExponentialTimer | null = null;
  private readonly maxMessageSize: number;
  private readonly heartbeatTimeout: number;

  private pendingAcks = new Map<string, (ok: BatchAckResult) => void>();
  private ackTimeoutMs = 5000;

  private secure = new SecureChannel();

  constructor(
    private readonly log: AppLogger,
    @Inject('IPC_OPTIONS') private readonly options: IpcServerOptions
  ) {
    super();

    if (!process.send) throw new Error('IpcProducer must run in a child process with IPC');

    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.IPC;
    this.heartbeatTimeout = options.heartbeatTimeout ?? 10000;

    // Start periodic ping immediately on app boot.
    this._timer = exponentialIntervalAsync(
      async (reset) => {
        try {
          await this.sendPing();
        } catch {
          reset();
        }
      },
      { interval: 500, maxInterval: 3000, multiplier: 2 }
    );
  }

  onModuleDestroy(): void {
    this._timer?.destroy();
    this._timer = null;
  }

  /** Called by Consumer when receiving 'pong'. */
  public markPong(): void {
    this.lastPongTime = Date.now();
  }

  /** Connection becomes "alive" after first PONG and stays alive within heartbeat timeout. */
  public isConnected(timeoutMs?: number): boolean {
    const timeout = timeoutMs ?? this.heartbeatTimeout;
    return process.connected && Date.now() - this.lastPongTime < timeout;
  }

  /** Consumer calls on 'secureHello' and expects us to return reply frame to send. */
  public buildSecureReplyForHello(clientHelloPayload: any): OutgoingMessage<'secureKey', any> {
    const reply = this.secure.handleClientHello(clientHelloPayload);
    return { action: reply.action, payload: reply.payload, timestamp: Date.now() };
  }

  /** Consumer calls on 'secureAck' to finalize DH. */
  public finalizeSecure(payload: any): void {
    this.secure.finalize(payload);
  }

  /** Periodic ping (server → client). If process disconnected, throws to reset timer backoff. */
  public async sendPing(): Promise<void> {
    if (!process.send || !process.connected) {
      throw new ConnectionError('IPC not connected', { transportType: 'ipc' });
    }
    const msg: OutgoingMessage = { action: 'ping', payload: {}, timestamp: Date.now() };
    const wrapped = this.secure.wrap(msg);
    validateMessageSize(wrapped, this.maxMessageSize, 'ipc');

    await new Promise<void>((resolve, reject) => {
      process.send!(wrapped, (err: any) =>
        err ? reject(new ConnectionError('Failed to send IPC ping', { transportType: 'ipc', cause: err })) : resolve()
      );
    });
  }

  /** Generic RPC response/message. */
  public async sendMessage(message: OutgoingMessage): Promise<void> {
    if (!process.send || !process.connected)
      throw new ConnectionError('Process not connected', { transportType: 'ipc' });
    if (!this.isConnected()) throw new ConnectionError('IPC connection lost', { transportType: 'ipc' });

    const wrapped = this.secure.wrap(message);
    validateMessageSize(wrapped, this.maxMessageSize, 'ipc');

    await new Promise<void>((resolve, reject) => {
      process.send!(wrapped, (err: any) =>
        err
          ? reject(new ConnectionError('Failed to send IPC message', { transportType: 'ipc', cause: err }))
          : resolve()
      );
    });
  }

  /**
   * Send outbox wire batch and await ACK.
   * Consumer will receive 'outboxStreamAck' and call `resolveOutboxAck(batchId, ackResult)`.
   * Timeout → reject to force upper layer to retry later.
   */
  public async sendOutboxStreamBatchWithAck(
    events: WireEventRecord[],
    opts?: { timeoutMs?: number }
  ): Promise<BatchAckResult> {
    if (!process.send || !process.connected) {
      throw new ConnectionError('Process not connected', { transportType: 'ipc' });
    }
    if (!this.isConnected()) throw new ConnectionError('IPC connection lost', { transportType: 'ipc' });

    const batchId = `${process.pid}:${Date.now()}:${Math.random()}`;
    const payload: OutboxStreamBatchPayload = { batchId, events };
    const message: OutgoingMessage<'outboxStreamBatch', OutboxStreamBatchPayload> = {
      action: 'outboxStreamBatch',
      payload,
      timestamp: Date.now(),
    };
    const wrapped = this.secure.wrap(message);
    validateMessageSize(wrapped, this.maxMessageSize, 'ipc');

    const timeoutMs = opts?.timeoutMs ?? this.ackTimeoutMs;
    const ackPromise = new Promise<BatchAckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(batchId);
        reject(new ConnectionError('IPC outbox stream ACK timeout', { transportType: 'ipc' }));
      }, timeoutMs);
      this.pendingAcks.set(batchId, (ok) => {
        clearTimeout(timer);
        resolve(ok.allOk ? { allOk: true } : ok);
      });
    });

    await new Promise<void>((resolve, reject) => {
      process.send!(wrapped, (err: any) =>
        err
          ? reject(new ConnectionError('Failed to send IPC outbox stream', { transportType: 'ipc', cause: err }))
          : resolve()
      );
    });

    return await ackPromise;
  }

  /** Called by Consumer when 'outboxStreamAck' arrives. */
  public resolveOutboxAck(batchId: string, res: BatchAckResult) {
    const done = this.pendingAcks.get(batchId);
    if (done) {
      this.pendingAcks.delete(batchId);
      done(res);
    }
  }
}
