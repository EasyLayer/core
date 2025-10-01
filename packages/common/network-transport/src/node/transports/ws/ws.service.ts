import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import * as fs from 'node:fs';
import type { QueryBus } from '@easylayer/common/cqrs';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { Actions, buildQuery } from '../../../core';
import type { Message, OutboxStreamAckPayload, TransportPort } from '../../../core';

export interface WsServiceOptions {
  type: 'ws';
  host: string;
  port: number;
  path?: string; // default: '/ws'
  token?: string; // optional shared secret for handshake (Sec-WebSocket-Protocol)
  clientId?: string; // if provided, we log/match expected client id
  tls?: { key: string; cert: string; ca?: string } | null;
  /** ACK wait timeout; must exceed client processing timeout (client default = 3000ms). */
  ackTimeoutMs?: number; // default: 4500
  /** App-level heartbeat (exponential backoff). */
  ping?: { factor?: number; minMs?: number; maxMs?: number; staleMs?: number; password?: string };
  /** Max message size (bytes). */
  maxWireBytes?: number; // default: 1 MiB
}

/**
 * WebSocket transport (server-side)
 * -----------------------------------------------------------------------------
 * - Accepts exactly one client at a time (new connection replaces the previous).
 * - Auth via Sec-WebSocket-Protocol: token,clientId (optional).
 * - Sends app-level Ping with exponential backoff; marks peer online only after a valid Pong.
 * - Streams Outbox batches and waits for a single OutboxStreamAck per batch.
 * - Handles Query exclusively via WS messages (QueryRequest -> QueryResponse).
 */
@Injectable()
export class WsTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ws' as const;

  private readonly log = new Logger(WsTransportService.name);
  private readonly server: HttpServer | HttpsServer;
  private readonly wss: WebSocketServer;

  private socket: WebSocket | null = null;
  private socketClientId: string | null = null;

  private readonly path: string;
  private readonly token?: string;
  private readonly expectedClientId?: string;
  private readonly ackTimeoutMs: number;
  private readonly maxWireBytes: number;

  private online = false;
  private lastPongAt = 0;

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: {
    resolve: (v: OutboxStreamAckPayload) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(
    private readonly opts: WsServiceOptions,
    private readonly queryBus: QueryBus
  ) {
    if (!opts.host || !opts.port) throw new Error('WS: host/port are required');

    this.path = opts.path ?? '/ws';
    this.token = opts.token;
    this.expectedClientId = opts.clientId;
    this.ackTimeoutMs = Math.max(1, opts.ackTimeoutMs ?? 4_500);
    this.maxWireBytes = Math.max(1024, opts.maxWireBytes ?? 1024 * 1024);

    // Bare HTTP(S) server only for upgrade; no HTTP routes.
    if (opts.tls) {
      const key = fs.readFileSync(opts.tls.key);
      const cert = fs.readFileSync(opts.tls.cert);
      const ca = opts.tls.ca ? fs.readFileSync(opts.tls.ca) : undefined;
      this.server = createHttpsServer({ key, cert, ca });
    } else {
      this.server = createServer();
    }

    this.wss = new WebSocketServer({ server: this.server, path: this.path, maxPayload: this.maxWireBytes });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (err) => this.log.error('wss error', err as any));
    this.server.listen(opts.port, opts.host, () =>
      this.log.log(`WS server listening at ${opts.host}:${opts.port}${this.path}`)
    );

    // Heartbeat with exponential backoff
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    this.closeSocket(1001, 'shutdown');
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- TransportPort API ----------------------------------------------------
  isOnline(): boolean {
    const stale = this.opts.ping?.staleMs ?? 15_000;
    return (
      this.online && Date.now() - this.lastPongAt < stale && !!this.socket && this.socket.readyState === WebSocket.OPEN
    );
  }

  /**
   * Waits until a valid Pong marks the peer online, or fails on deadline.
   * Strict semantics: an OPEN socket is NOT enough — we require app-level Pong.
   */
  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      if (this.isOnline()) return;
      // Nudge heartbeat to emit next Ping earlier
      this.heartbeatReset?.();
      await delay(1000);
    }
    throw new Error('WS: peer is offline (no valid Pong)');
  }

  async send(msg: Message | string): Promise<void> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WS: no active client');

    const body = typeof msg === 'string' ? msg : JSON.stringify(msg);
    if (Buffer.byteLength(body) > this.maxWireBytes) throw new Error('WS: payload too large');

    await new Promise<void>((resolve, reject) => ws.send(body, (err) => (err ? reject(err) : resolve())));
  }

  async waitForAck(deadlineMs?: number): Promise<OutboxStreamAckPayload> {
    const finalDeadline = Math.max(1, deadlineMs ?? this.ackTimeoutMs);
    if (this.lastAckBuffer) {
      const ack = this.lastAckBuffer;
      this.lastAckBuffer = null;
      return ack;
    }
    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error('WS: ACK timeout'));
      }, finalDeadline);
      this.pendingAck = {
        resolve: (v) => {
          clearTimeout(t);
          this.pendingAck = null;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          this.pendingAck = null;
          reject(e);
        },
        timer: t,
      };
    });
  }

  /* eslint-disable no-empty */
  // ---- WS lifecycle ---------------------------------------------------------
  private onConnection(ws: WebSocket, req: any) {
    try {
      const { token, clientId } = parseAuth(req, this.token);
      if (this.expectedClientId && clientId !== this.expectedClientId) {
        this.log.warn(`Unexpected clientId: got=${clientId}, want=${this.expectedClientId}`);
      }

      // Enforce single active client: close previous if any
      if (this.socket && this.socket !== ws) this.closeSocket(1000, 'replaced');
      this.socket = ws;
      this.socketClientId = clientId ?? null;

      // IMPORTANT: Do not mark online on connection; require a valid Pong.
      this.online = false;
      this.lastPongAt = 0;

      ws.on('message', (data) => this.onMessage(String(data)));
      ws.on('close', (code, reason) => this.onClose(code, String(reason)));
      ws.on('error', (err) => this.onError(err));

      this.log.log(`WS client connected: clientId=${clientId ?? '<n/a>'}`);

      // Ask heartbeat to ping sooner after a new connection
      this.heartbeatReset?.();
    } catch (e: any) {
      this.log.warn(`WS connection rejected: ${String(e?.message ?? e)}`);
      try {
        ws.close(1008, 'unauthorized');
      } catch {}
    }
  }
  /* eslint-enable no-empty */

  private onMessage(text: string) {
    let msg: Message | null = null;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof (msg as any).action !== 'string') return;

    switch (msg.action) {
      case Actions.Pong: {
        const want = this.opts.ping?.password;
        const got = (msg.payload as any)?.password;
        if (!want || want === got) {
          this.online = true;
          this.lastPongAt = Date.now();
        } else {
          this.online = false; // invalid pong
        }
        break;
      }
      case Actions.OutboxStreamAck: {
        const ack = (msg.payload ?? {}) as OutboxStreamAckPayload;
        if (this.pendingAck) this.pendingAck.resolve(ack);
        else this.lastAckBuffer = ack;
        break;
      }
      case Actions.QueryRequest: {
        const { name, dto } = (msg.payload as any) || {};
        this.handleQuery(name, dto);
        break;
      }
      default:
        // ignore anything else
        break;
    }
  }

  private async handleQuery(name: string, dto: any) {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const base: Omit<Message, 'payload'> = { action: Actions.QueryResponse, timestamp: Date.now() } as any;
    try {
      if (!name || typeof name !== 'string') throw new Error('Invalid query payload');
      const data = await this.queryBus.execute(buildQuery({ name, dto }));
      const resp: Message = { ...base, payload: { ok: true, data } } as any;
      ws.send(JSON.stringify(resp));
    } catch (e: any) {
      const resp: Message = { ...base, payload: { ok: false, err: String(e?.message ?? e) } } as any;
      ws.send(JSON.stringify(resp));
    }
  }

  private onClose(code: number, reason: string) {
    this.online = false;
    if (this.pendingAck) {
      this.pendingAck.reject(new Error(`WS closed: ${code} ${reason || ''}`.trim()));
      this.pendingAck = null;
    }
    this.socket = null;
    this.socketClientId = null;
    this.log.warn(`WS client disconnected: ${code} ${reason || ''}`.trim());
  }

  private onError(err: any) {
    this.log.warn(`WS error: ${String(err?.message ?? err)}`);
  }

  /* eslint-disable no-empty */
  private closeSocket(code = 1000, reason?: string) {
    try {
      this.socket?.close(code, reason);
    } catch {}
    this.socket = null;
    this.socketClientId = null;
    this.online = false;
  }
  /* eslint-enable no-empty */

  // ---- Heartbeat with exponential backoff -----------------------------------
  private startHeartbeat() {
    const multiplier = this.opts.ping?.factor ?? 1.6;
    const interval = this.opts.ping?.minMs ?? 600;
    const maxInterval = this.opts.ping?.maxMs ?? 5_000;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;
        const ws = this.socket;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          this.online = false;
          return; // wait for next tick
        }
        const ping: Message = { action: Actions.Ping, timestamp: Date.now() } as any;
        try {
          ws.send(JSON.stringify(ping));
        } catch (e) {
          this.online = false;
          this.log.warn(`WS ping failed: ${String((e as any)?.message ?? e)}`);
        }
      },
      { multiplier, interval, maxInterval }
    );
  }

  private stopHeartbeat() {
    try {
      this.heartbeatController?.destroy();
    } finally {
      this.heartbeatController = null;
    }
  }
}

// -- helpers ------------------------------------------------------------------
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function parseAuth(req: any, expectedToken?: string): { token?: string; clientId?: string } {
  // Prefer Sec-WebSocket-Protocol: "token,clientId". Accept query fallback.
  const proto = (req.headers?.['sec-websocket-protocol'] as string | undefined)?.trim();
  const qp = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const token = proto?.split(',')[0]?.trim() || qp.get('token') || undefined;
  const clientId = proto?.split(',')[1]?.trim() || qp.get('clientId') || undefined;
  if (expectedToken && token !== expectedToken) throw new Error('unauthorized');
  return { token, clientId: clientId || undefined };
}
