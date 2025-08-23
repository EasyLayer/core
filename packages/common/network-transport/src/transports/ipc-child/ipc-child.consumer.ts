import { BaseConsumer } from '../../core';
import type { AppLogger } from '@easylayer/common/logger';
import type {
  Envelope,
  OutboxStreamAckPayload,
  RegisterStreamConsumerPayload,
  RpcRequestPayload,
  RpcResponsePayload,
} from '../../shared';
import { Actions } from '../../shared';

/**
 * IPC child consumer:
 * - Handles ping→pong, RPC with correlationId, and can process outbox batch
 *   (if child acts as the receiver) and reply OutboxStreamAck with same correlationId.
 * Memory: O(1) per message; allocations = reply envelopes only.
 */
export class IpcChildConsumer extends BaseConsumer {
  private readonly token?: string;

  constructor(log: AppLogger, opts?: { token?: string }) {
    super(log);
    this.token = opts?.token;
    this.attach();
  }

  private attach() {
    process.on('message', async (raw: any) => {
      if (typeof raw !== 'string') return;
      let msg: Envelope<any>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      await this.onMessage(msg);
    });
  }

  protected async handleBusinessMessage(msg: Envelope, _ctx?: unknown): Promise<void> {
    switch (msg.action) {
      case Actions.RegisterStreamConsumer: {
        // Usually parent initiates for WS; IPC child can ignore or implement handshake if needed.
        return;
      }

      case Actions.OutboxStreamBatch: {
        // If child is the actual consumer of outbox -> process and ACK with the same correlationId.
        // Here we just send a generic allOk=true ack to demonstrate the strict correlationId round-trip.
        const ack: Envelope<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          correlationId: msg.correlationId, // MUST mirror
          payload: { allOk: true },
          timestamp: Date.now(),
        };
        await this._send(ack);
        return;
      }

      case Actions.RpcRequest: {
        const req = (msg.payload || {}) as RpcRequestPayload;
        try {
          const data = await this.dispatch(req.route, req.data);
          const resp: Envelope<RpcResponsePayload> = {
            action: Actions.RpcResponse,
            correlationId: msg.correlationId,
            payload: { route: req.route, data },
            timestamp: Date.now(),
            requestId: msg.requestId,
          };
          await this._send(resp);
        } catch (e: any) {
          const resp: Envelope<RpcResponsePayload> = {
            action: Actions.RpcResponse,
            correlationId: msg.correlationId,
            payload: { route: req.route, err: String(e?.message ?? e) },
            timestamp: Date.now(),
            requestId: msg.requestId,
          };
          await this._send(resp);
        }
        return;
      }

      default:
        return;
    }
  }

  protected async _send(msg: Envelope): Promise<void> {
    if (process.send) process.send(JSON.stringify(msg));
  }

  // Application routes living in the child process (example)
  private async dispatch(route: string, data: any): Promise<any> {
    switch (route) {
      case 'health':
        return { ok: true };
      default:
        return { ok: true, route, echo: data };
    }
  }

  /** Optional: child can proactively register as stream-consumer (if your protocol needs it). */
  public registerAsStreamConsumer() {
    const payload: RegisterStreamConsumerPayload = { token: this.token };
    const m: Envelope = { action: Actions.RegisterStreamConsumer, payload, timestamp: Date.now() };
    this._send(m);
  }
}
