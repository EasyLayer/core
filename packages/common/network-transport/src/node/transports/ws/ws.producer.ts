import type { Server as SocketIOServer, Socket } from 'socket.io';
import { randomBytes, createHmac } from 'node:crypto';
import { BaseProducer, Actions } from '../../../core';
import type { Envelope } from '../../../core';

export type WsProducerConfig = {
  name: 'ws';
  maxMessageBytes: number;
  ackTimeoutMs: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  token?: string;
};

export class WsProducer extends BaseProducer {
  private server: SocketIOServer | null = null;
  private streamingClientId: string | null = null;

  private readonly token?: string;
  private readonly nonces: Map<string, Map<string, number>> = new Map(); // socketId -> nonce -> ts

  constructor(cfg: WsProducerConfig) {
    super({
      name: cfg.name,
      maxMessageBytes: cfg.maxMessageBytes,
      ackTimeoutMs: cfg.ackTimeoutMs,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs ?? 1000,
      heartbeatTimeoutMs: cfg.heartbeatTimeoutMs ?? cfg.ackTimeoutMs,
    });
    this.token = cfg.token;
  }

  public setServer(server: SocketIOServer): void {
    this.server = server;
  }
  public setStreamingClient(id: string | null): void {
    this.streamingClientId = id;
  }

  private getClient(): Socket | null {
    if (!this.server || !this.streamingClientId) return null;
    const sock = (this.server.sockets as any).sockets?.get(this.streamingClientId);
    return sock ?? null;
  }

  protected _isUnderlyingConnected(): boolean {
    return !!this.getClient();
  }

  protected override buildPingEnvelope(): Envelope<{ ts: number; nonce?: string; sid?: string }> {
    const client = this.getClient();
    if (!client) return super.buildPingEnvelope();

    const sid = client.id;
    const nonce = randomBytes(16).toString('hex');
    const ts = Date.now();

    let bucket = this.nonces.get(sid);
    if (!bucket) {
      bucket = new Map();
      this.nonces.set(sid, bucket);
    }
    bucket.set(nonce, ts);

    return {
      action: Actions.Ping,
      payload: { ts, nonce, sid },
      timestamp: ts,
    };
  }

  public consumeNonce(sid: string, nonce: string, maxAgeMs: number): boolean {
    const bucket = this.nonces.get(sid);
    if (!bucket) return false;
    const ts = bucket.get(nonce);
    if (typeof ts !== 'number') return false;
    bucket.delete(nonce);
    if (Date.now() - ts > maxAgeMs) return false;
    return true;
  }

  protected async _sendRaw(serialized: string): Promise<void> {
    const client = this.getClient();
    if (!client) throw new Error('[ws] no streaming client connected');
    client.emit('message', serialized);
  }

  public onClientPong(): void {
    this.onPong();
  }

  /** HMAC(proof) = HMAC_SHA256(nonce|ts|sid, token) */
  public verifyProof(sid: string, nonce: string, ts: number, proof: string): boolean {
    if (!this.token) return false;
    const windowMs = Math.min(30000, (this as any).configuration.heartbeatTimeoutMs || 10000);
    if (!this.consumeNonce(sid, nonce, windowMs)) return false;

    const expected = createHmac('sha256', this.token).update(`${nonce}|${ts}|${sid}`).digest('hex');
    return expected === proof;
  }
}
