import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AppLogger } from '@easylayer/common/logger';
import type {
  Envelope,
  RegisterStreamConsumerPayload,
  OutboxStreamAckPayload,
  RpcRequestPayload,
  RpcResponsePayload,
} from '../../shared';
import { Actions } from '../../shared';
import type { WsProducer } from './ws.producer';

/**
 * WsGateway (plain class, no Nest decorators here):
 * - setServer(server) is called by WsServerManager.
 * - handleMessage(raw, socket) is called by WsServerManager for each incoming "message".
 * - Stream ACK goes DIRECTLY to WsProducer.resolveAck(...) (no ProducersManager in-between).
 * - RPC replies go back to the same socket, preserving correlationId.
 */
export class WsGateway {
  private server: SocketIOServer | null = null;

  constructor(
    private readonly logger: AppLogger,
    private readonly producer: WsProducer
  ) {}

  public setServer(server: SocketIOServer) {
    this.server = server;
  }

  public async handleMessage(raw: any, client: Socket): Promise<void> {
    let msg: Envelope<any>;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    switch (msg.action) {
      case Actions.Pong: {
        // consider Pong only from the selected streaming client
        if (client.id === (this.producer as any).streamingClientId) {
          this.producer.onClientPong();
        }
        return;
      }

      case Actions.RegisterStreamConsumer: {
        // simple token check: keep it optional
        const p = (msg.payload || {}) as RegisterStreamConsumerPayload;
        const expected = (this.producer as any)['cfg']?.token;
        if (expected && p.token !== expected) {
          client.emit('message', JSON.stringify({ action: Actions.Error, payload: { err: 'unauthorized' } }));
          client.disconnect(true);
          return;
        }
        this.producer.setStreamingClient(client.id);
        return;
      }

      case Actions.OutboxStreamAck: {
        // Accept ACK only from the registered streaming client
        if (client.id !== (this.producer as any).streamingClientId) return;
        const payload = (msg.payload || {}) as OutboxStreamAckPayload;
        if (typeof payload.allOk === 'boolean') {
          // resolve BaseProducer.waitForAck(...) directly
          this.producer.resolveAck(payload);
        }
        return;
      }

      case Actions.RpcRequest: {
        const q = (msg.payload || {}) as RpcRequestPayload;
        try {
          const data = await this.dispatch(q.route, q.data, client);
          const resp: Envelope<RpcResponsePayload> = {
            action: Actions.RpcResponse,
            payload: { route: q.route, data },
            correlationId: msg.correlationId,
            timestamp: Date.now(),
            requestId: msg.requestId,
          };
          client.emit('message', JSON.stringify(resp));
        } catch (e: any) {
          const resp: Envelope<RpcResponsePayload> = {
            action: Actions.RpcResponse,
            payload: { route: q.route, err: String(e?.message ?? e) },
            correlationId: msg.correlationId,
            timestamp: Date.now(),
            requestId: msg.requestId,
          };
          client.emit('message', JSON.stringify(resp));
        }
        return;
      }

      default:
        return;
    }
  }

  // App-specific RPC routing lives here; keep minimal stub.
  private async dispatch(route: string, data: any, _client: Socket): Promise<any> {
    switch (route) {
      case 'health':
        return { ok: true };
      default:
        return { ok: true, route, echo: data };
    }
  }
}
