import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { QueryBus } from '@easylayer/common/cqrs';
import { Actions } from '../../../core';
import type { Message, TransportPort, OutboxStreamAckPayload } from '../../../core';

export interface WsServerOptions {
  type: 'ws';
  host: string; // required
  port: number; // required
  tls?: { key: string; cert: string; ca?: string } | null; // if set -> wss
  password?: string; // optional; if absent, first valid pong binds the client
  ping?: { staleMs?: number; factor?: number; minMs?: number; maxMs?: number };
}

/**
 * WS/WSS transport with a single accepted client.
 */
@Injectable()
export class WsTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ws' as const;

  private readonly log = new Logger(WsTransportService.name);
  private readonly server: http.Server | https.Server;
  private readonly wss: WebSocketServer;

  private client: WebSocket | null = null;
  private clientId: string | undefined;

  private online = false;
  private lastPongAt = 0;

  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: {
    resolve: (v: OutboxStreamAckPayload) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  private pendingHandshakeClient: WebSocket | null = null; // candidate until valid pong

  constructor(
    private readonly opts: WsServerOptions,
    private readonly queryBus: QueryBus
  ) {
    if (!opts.host || !opts.port) throw new Error('WS: host/port are required');

    this.server = opts.tls
      ? https.createServer({
          key: fs.readFileSync(opts.tls.key),
          cert: fs.readFileSync(opts.tls.cert),
          ca: opts.tls.ca ? fs.readFileSync(opts.tls.ca) : undefined,
        })
      : http.createServer();

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (socket) => {
      // Only one logical client is allowed; keep new connection as a candidate until it proves via pong.
      this.pendingHandshakeClient = socket;
      this.clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      socket.on('message', (data) => this.onRaw(data, socket));
      socket.on('close', () => {
        if (this.client === socket) {
          this.client = null;
          this.online = false;
        }
        if (this.pendingHandshakeClient === socket) this.pendingHandshakeClient = null;
      });
    });

    this.server.listen(opts.port, opts.host);
    this.log.log(`WS server listening at ${opts.host}:${opts.port}`);

    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    this.wss.clients.forEach((c) => c.close());
    await new Promise<void>((resolve) => {
      this.wss.close();
      this.server.close(() => resolve());
    });
  }

  // ----- BATCH/PING SECTION -----
  isOnline(): boolean {
    const stale = this.opts.ping?.staleMs ?? 15_000;
    return !!this.client && this.online && Date.now() - this.lastPongAt < stale;
  }

  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!this.isOnline()) {
      this.heartbeatReset?.();
      if (this.isOnline()) break;
      if (Date.now() - start >= deadlineMs) throw new Error('WS: not online');
      await delay(120);
    }
  }

  async send(msg: Message | string): Promise<void> {
    const s = this.client;
    if (!s || s.readyState !== s.OPEN) throw new Error('WS: no active client');

    const frame = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.log.debug(`WS send action=${typeof msg === 'string' ? '<string>' : (msg as Message).action}`);

    await new Promise<void>((resolve, reject) => s.send(frame, (err) => (err ? reject(err) : resolve())));
  }

  async waitForAck(deadlineMs = 2_000): Promise<OutboxStreamAckPayload> {
    if (this.lastAckBuffer) {
      const ack = this.lastAckBuffer;
      this.lastAckBuffer = null;
      return ack;
    }
    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error('WS: ACK timeout'));
      }, deadlineMs);
      this.pendingAck = {
        resolve: (v) => {
          clearTimeout(timer);
          this.pendingAck = null;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pendingAck = null;
          reject(e);
        },
        timer,
      };
    });
  }

  private startHeartbeat() {
    const multiplier = this.opts.ping?.factor ?? 1.6;
    const interval = this.opts.ping?.minMs ?? 600;
    const maxInterval = this.opts.ping?.maxMs ?? 5000;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;

        // Send ping to current client and candidate; ping has no password.
        const targets: (WebSocket | null)[] = [this.client, this.pendingHandshakeClient];
        const ping: Message = {
          action: Actions.Ping,
          clientId: this.clientId,
          timestamp: Date.now(),
        };

        await Promise.all(
          targets.map(async (s) => {
            if (!s || s.readyState !== s.OPEN) return;
            try {
              s.send(JSON.stringify(ping));
              this.log.verbose('WS ping published');
            } catch (e: any) {
              this.log.debug(`WS ping error: ${e?.message ?? e}`);
            }
          })
        );
      },
      { interval, multiplier, maxInterval }
    );
  }

  private stopHeartbeat() {
    this.heartbeatController?.destroy?.();
    this.heartbeatController = null;
    this.heartbeatReset = null;
  }

  private onRaw(raw: unknown, socket: WebSocket) {
    const msg = this.normalize(raw);
    if (!msg) return;

    switch (msg.action) {
      case Actions.Pong: {
        const pw = (msg.payload as any)?.password;
        const ok = this.opts.password ? pw === this.opts.password : true;
        if (ok) {
          // If no password is configured, bind the first pong sender as the client.
          if (!this.client && this.pendingHandshakeClient === socket) {
            this.client = socket;
            this.pendingHandshakeClient = null;
          }
          this.lastPongAt = Date.now();
          this.online = true;
          this.log.verbose('WS pong accepted');
        }
        return;
      }
      case Actions.OutboxStreamAck: {
        const ack = msg.payload as any as OutboxStreamAckPayload;
        if (this.pendingAck) this.pendingAck.resolve(ack);
        else this.lastAckBuffer = ack;
        return;
      }
      // ----- QUERY SECTION -----
      case Actions.QueryRequest: {
        if (socket !== this.client) return;
        void this.handleQuery(msg);
        return;
      }
      default:
        return;
    }
  }

  private async handleQuery(msg: Message): Promise<void> {
    const name = (msg.payload as any)?.name;
    const data = (msg.payload as any)?.data;
    if (typeof name !== 'string') return;

    try {
      const query = { name, data } as any;
      const result = await this.queryBus.execute(query);
      const reply: Message = {
        action: Actions.QueryResponse,
        payload: { ok: true, data: result },
        clientId: this.clientId,
        requestId: msg.requestId,
        timestamp: Date.now(),
      };
      await this.send(reply);
    } catch (e: any) {
      const reply: Message = {
        action: Actions.QueryResponse,
        payload: { ok: false, err: String(e?.message ?? e) },
        clientId: this.clientId,
        requestId: msg.requestId,
        timestamp: Date.now(),
      };
      await this.send(reply);
    }
  }

  private normalize(raw: unknown): Message | null {
    if (!raw) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Message;
      } catch {
        return null;
      }
    }
    if (Buffer.isBuffer(raw)) {
      try {
        return JSON.parse(raw.toString('utf8')) as Message;
      } catch {
        return null;
      }
    }
    if (typeof raw === 'object') return raw as Message;
    return null;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
