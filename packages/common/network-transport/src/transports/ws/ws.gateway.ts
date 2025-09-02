import { Injectable, Inject } from '@nestjs/common';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { QueryBus } from '@easylayer/common/cqrs';
import type {
  Envelope,
  RegisterStreamConsumerPayload,
  QueryRequestPayload,
  QueryResponsePayload,
  OutboxStreamAckPayload,
  PongPayload,
} from '../../shared';
import { Actions } from '../../shared';
import { WsProducer } from './ws.producer';
import { BaseConsumer } from '../../core/base-consumer';

@Injectable()
export class WsGateway extends BaseConsumer {
  private server: SocketIOServer | null = null;

  constructor(
    private readonly queryBus: QueryBus,
    private readonly producer: WsProducer,
    private readonly token?: string
  ) {
    super();
  }

  public setServer(server: SocketIOServer): void {
    this.server = server;
  }

  public async handleMessage(raw: any, client: Socket): Promise<void> {
    const msg: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;

    switch (msg.action) {
      case Actions.Ping: {
        const reply: Envelope = { action: Actions.Pong, payload: { ts: Date.now() }, timestamp: Date.now() };
        client.emit('message', JSON.stringify(reply));
        return;
      }

      case Actions.Pong: {
        const p = (msg.payload || {}) as PongPayload;
        const sid = p.sid || client.id;
        const nonce = p.nonce || '';
        const ts = typeof p.ts === 'number' ? p.ts : Date.now();
        const proof = p.proof || '';

        if (this.token && nonce && proof) {
          if (this.producer.verifyProof(sid, nonce, ts, proof)) {
            this.producer.setStreamingClient(client.id);
            this.producer.onClientPong();
          }
        } else {
          this.producer.onClientPong();
        }
        return;
      }

      case Actions.RegisterStreamConsumer: {
        const _payload = msg.payload as RegisterStreamConsumerPayload | undefined;
        return;
      }

      case Actions.QueryRequest: {
        await this.handleQueryOverWs(msg as Envelope<QueryRequestPayload>, client);
        return;
      }

      case Actions.OutboxStreamAck: {
        const ack = (msg.payload || {}) as OutboxStreamAckPayload;
        (this.producer as any).resolveAck(ack);
        return;
      }

      default:
        return;
    }
  }

  private async handleQueryOverWs(message: Envelope<QueryRequestPayload>, client: Socket): Promise<void> {
    const name = message?.payload?.name ?? '';
    const dto = message?.payload?.dto;
    try {
      const data = await this.executeQuery(this.queryBus, { name, dto });
      const reply: Envelope<QueryResponsePayload> = {
        action: Actions.QueryResponse,
        payload: { name, data },
        correlationId: message.correlationId,
        requestId: message.requestId,
        timestamp: Date.now(),
      };
      client.emit('message', JSON.stringify(reply));
    } catch (e: any) {
      const reply: Envelope<QueryResponsePayload> = {
        action: Actions.QueryResponse,
        payload: { name, err: String(e?.message ?? e) },
        correlationId: message.correlationId,
        requestId: message.requestId,
        timestamp: Date.now(),
      };
      client.emit('message', JSON.stringify(reply));
    }
  }

  protected async handleBusinessMessage(): Promise<void> {
    return;
  }
  protected async _send(): Promise<void> {
    return;
  }
}
