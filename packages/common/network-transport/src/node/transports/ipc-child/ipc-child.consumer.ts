import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { BaseConsumer } from '../../../core';
import type { Envelope, QueryRequestPayload, QueryResponsePayload, PongPayload } from '../../../core';
import { Actions } from '../../../core';
import { IpcChildProducer } from './ipc-child.producer';

export interface IpcServerOptions {
  type: 'ipc';
  maxMessageSize?: number;
  heartbeatTimeout?: number;
  connectionTimeout?: number;
  token?: string;
}

@Injectable()
export class IpcChildConsumer extends BaseConsumer implements OnModuleDestroy {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly producer: IpcChildProducer,
    @Inject('IPC_OPTIONS') private readonly options: IpcServerOptions
  ) {
    super();
    if (!process.send) {
      throw new Error('IPC transport requires running in a child process with IPC channel');
    }
    process.on('message', this.handleMessage);
  }

  public async onModuleDestroy(): Promise<void> {
    process.removeListener('message', this.handleMessage);
  }

  private handleMessage = async (raw: unknown) => {
    if (!raw) return;
    const message: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw as string) : (raw as any);
    await this.onMessage(message);
  };

  protected async handlePong(message: Envelope<PongPayload>): Promise<void> {
    const p = message.payload;
    if (this.options.token && p?.nonce && p.proof) {
      if (this.producer.verifyProof(p.nonce, p.ts || Date.now(), p.proof)) {
        this.producer.onPong();
      }
    } else {
      this.producer.onPong();
    }
  }

  protected async handleQueryMessage(message: Envelope<QueryRequestPayload>): Promise<void> {
    const name = message?.payload?.name ?? '';
    const dto = message?.payload?.dto;
    try {
      const data = await this.executeQuery(this.queryBus, name, dto);
      const reply: Envelope<QueryResponsePayload> = {
        action: Actions.QueryResponse,
        payload: { name, data },
        correlationId: message.correlationId,
        requestId: message.requestId,
        timestamp: Date.now(),
      };
      await this._send(reply);
    } catch (e: any) {
      const reply: Envelope<QueryResponsePayload> = {
        action: Actions.QueryResponse,
        payload: { name, err: String(e?.message ?? e) },
        correlationId: message.correlationId,
        requestId: message.requestId,
        timestamp: Date.now(),
      };
      await this._send(reply);
    }
  }

  protected async handleBusinessMessage(_message: Envelope): Promise<void> {
    return;
  }
  protected async _send(message: Envelope): Promise<void> {
    await this.producer.sendMessage(message);
  }
}
