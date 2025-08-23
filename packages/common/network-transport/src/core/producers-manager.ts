import type { AppLogger } from '@easylayer/common/logger';
import type { BaseProducer } from './base-producer';
import type { Envelope, OutboxStreamAckPayload, OutboxStreamBatchPayload, WireEventRecord } from '../shared';
import { Actions } from '../shared';

/**
 * ProducersManager:
 * - Keeps a named registry of producers and a single "streaming" one.
 * - streamWireWithAck(): if no producer selected → return without error (allOk:false).
 * - If producer selected → await async connectivity up to 5s; if still offline → throw.
 * - For IPC, uses strict correlationId ACK path (producer-specific).
 * Complexity: O(1) lookups; allocations = envelope serialization only.
 */
export class ProducersManager {
  constructor(
    private readonly log: AppLogger,
    private readonly producers = new Map<string, BaseProducer>()
  ) {}

  private selectedStreamProducer: string | null = null;

  public register(name: string, p: BaseProducer) {
    this.producers.set(name, p);
  }
  public setStreamingProducer(name: string | null) {
    this.selectedStreamProducer = name;
  }

  public getStreamingProducer(): BaseProducer | null {
    if (!this.selectedStreamProducer) return null;
    return this.producers.get(this.selectedStreamProducer) ?? null;
  }

  public async streamWireWithAck(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    const prod = this.getStreamingProducer();

    // No producer configured → run without error (instance started without a streaming transport)
    if (!prod) {
      return { allOk: false, okIndices: [] };
    }

    // Async connectivity wait (connection-timeout semantics live here)
    const isUp = await prod.isConnected(5000);
    if (!isUp) throw new Error('Streaming producer is not connected (timeout)');

    // IPC strict ACK by correlationId, if the producer supports it
    const anyProd: any = prod;
    if (typeof anyProd.sendOutboxBatchAndWaitAckIPC === 'function') {
      return await anyProd.sendOutboxBatchAndWaitAckIPC(events);
    }

    // Generic non-correlated ACK path (WS resolves via gateway; HTTP usually doesn't use this path)
    const env: Envelope<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      payload: { events },
      timestamp: Date.now(),
    };

    const ack = await prod.waitForAck<OutboxStreamAckPayload>(async () => {
      await prod.sendMessage(env);
    });

    return ack;
  }
}
