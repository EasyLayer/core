import type { Server } from 'socket.io';
import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer, BatchAckResult } from '../../core';
import {
  OutgoingMessage,
  ClientNotFoundError,
  MESSAGE_SIZE_LIMITS,
  validateMessageSize,
  OutboxStreamBatchPayload,
} from '../../shared';
import type { WsServerOptions } from './ws.module';
import type { WireEventRecord } from '../../shared';

/**
 * WS Producer responsibilities:
 * - Periodically emit 'ping' frames on the socket.io server (server → clients).
 * - Switch to "connected" state after first 'pong' (set by Consumer via markPong()).
 * - Send generic responses via `sendMessage()`.
 * - Send outbox batches and wait for an ACK that WS Consumer provides via `resolveOutboxAck()`.
 *
 * Notes:
 * - Producer does not receive messages; WS Gateway (Consumer) handles inbound 'pong' and 'outboxStreamAck'.
 */
@Injectable()
export class WsProducer extends BaseProducer<OutgoingMessage> implements OnModuleDestroy {
  private lastPongTime = 0;
  private server: Server | null = null;
  private _timer: ExponentialTimer | null = null;
  private readonly maxMessageSize: number;
  private readonly heartbeatTimeout: number;

  private pendingAcks = new Map<string, (ok: BatchAckResult) => void>();
  private ackTimeoutMs = 5000;

  constructor(
    private readonly log: AppLogger,
    @Inject('WS_OPTIONS')
    private readonly options: WsServerOptions
  ) {
    super();
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.WS;
    this.heartbeatTimeout = options.heartbeatTimeout ?? 10000;

    // Start periodic ping immediately on boot.
    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.sendPing();
        } catch {
          resetInterval();
        }
      },
      { interval: 500, maxInterval: 3000, multiplier: 2 }
    );
  }

  setServer(server: Server) {
    this.server = server;
    // Not connected until first 'pong'
  }

  public async sendPing(): Promise<void> {
    if (!this.server) return;
    const msg: OutgoingMessage = { action: 'ping', payload: {}, timestamp: Date.now() };
    validateMessageSize(msg, this.maxMessageSize, 'ws');
    this.server.emit('message', msg);
  }

  async onModuleDestroy() {
    this._timer?.destroy();
    this._timer = null;
    this.server = null;
  }

  /** Called by Consumer on first/any 'pong'. */
  public markPong(): void {
    this.lastPongTime = Date.now();
  }

  /** Connection is considered alive N ms since last pong. */
  public isConnected(timeoutMs?: number): boolean {
    const timeout = timeoutMs ?? this.heartbeatTimeout;
    return this.server !== null && Date.now() - this.lastPongTime < timeout;
  }

  /** Generic message to all clients (fire-and-forget). */
  public async sendMessage(message: OutgoingMessage, targetServer?: Server): Promise<void> {
    const server = targetServer || this.server;
    if (!server) throw new ClientNotFoundError('WebSocket server not available');
    validateMessageSize(message, this.maxMessageSize, 'ws');
    if (!this.isConnected()) throw new ClientNotFoundError('WebSocket connection lost');
    server.emit('message', message);
  }

  /** Send outbox stream batch and await first ACK from any client. */
  public async sendOutboxStreamBatchWithAck(
    events: WireEventRecord[],
    opts?: { timeoutMs?: number }
  ): Promise<BatchAckResult> {
    const server = this.server;
    if (!server) throw new ClientNotFoundError('WebSocket server not available');
    if (!this.isConnected()) throw new ClientNotFoundError('WebSocket connection lost');

    const batchId = `ws:${Date.now()}:${Math.random()}`;
    const payload: OutboxStreamBatchPayload = { batchId, events };
    const message: OutgoingMessage<'outboxStreamBatch', OutboxStreamBatchPayload> = {
      action: 'outboxStreamBatch',
      payload,
      timestamp: Date.now(),
    };
    validateMessageSize(message, this.maxMessageSize, 'ws');

    const timeoutMs = opts?.timeoutMs ?? this.ackTimeoutMs;
    const ackPromise = new Promise<BatchAckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(batchId);
        reject(new ClientNotFoundError('WebSocket outbox ACK timeout'));
      }, timeoutMs);
      this.pendingAcks.set(batchId, (ok) => {
        clearTimeout(timer);
        resolve(ok.allOk ? { allOk: true } : ok);
      });
    });

    server.emit('message', message);
    return await ackPromise;
  }

  /** Called by Consumer when 'outboxStreamAck' arrives from any client. */
  public resolveOutboxAck(batchId: string, res: BatchAckResult) {
    const done = this.pendingAcks.get(batchId);
    if (done) {
      this.pendingAcks.delete(batchId);
      done(res);
    }
  }
}
