import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import type { ChildProcess } from 'node:child_process';
import { Actions } from '../../../core';
import type { Envelope, OutboxStreamAckPayload } from '../../../core';

/**
 * IpcParentGateway
 * - Wraps parent <-> child_process IPC to speak the same Envelope protocol.
 * - Provides send() and hooks for Pong/Ack handling.
 */
export interface IpcParentOptions {
  /** Provide a ready ChildProcess with established IPC channel */
  child: ChildProcess;
  /** Optional: ACK timeout ms if you want to implement waitForAck here as well */
  ackTimeoutMs?: number;
}

@Injectable()
export class IpcParentGateway implements OnModuleDestroy {
  private readonly child: ChildProcess;
  private pendingAck: ((ack: OutboxStreamAckPayload) => void) | null = null;

  constructor(@Inject('IPC_PARENT_OPTIONS') private readonly opts: IpcParentOptions) {
    if (!opts?.child?.send) {
      throw new Error('IpcParentGateway requires a ChildProcess with IPC channel');
    }
    this.child = opts.child;
    this.onChildMessage = this.onChildMessage.bind(this);
    this.child.on('message', this.onChildMessage);
  }

  onModuleDestroy(): void {
    this.child.off('message', this.onChildMessage);
  }

  private onChildMessage = (raw: unknown) => {
    try {
      const envelope: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
      if (!envelope || typeof envelope !== 'object') return;

      if (envelope.action === Actions.Pong) {
        // Parent can update connection health here if needed.
        return;
      }
      if (envelope.action === Actions.OutboxStreamAck) {
        if (this.pendingAck) {
          this.pendingAck((envelope.payload || {}) as OutboxStreamAckPayload);
          this.pendingAck = null;
        }
        return;
      }
      // Add more handlers if you expect QueryResponse etc. from child.
    } catch {
      // ignore malformed
    }
  };

  public send(envelope: Envelope<any>): void {
    try {
      this.child.send(JSON.stringify(envelope));
    } catch {
      // ignore
    }
  }

  public sendWithAck(envelope: Envelope<any>, onAck: (ack: OutboxStreamAckPayload) => void) {
    this.pendingAck = onAck;
    this.send(envelope);
  }
}
