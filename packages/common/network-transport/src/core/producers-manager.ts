import type { AppLogger } from '@easylayer/common/logger';
import type { BaseProducer } from './base-producer';
import type { OutgoingMessage, WireEventRecord } from '../shared';
import type { BatchAckResult } from './base-producer';

/**
 * ProducersManager manages many producers (HTTP/WS/IPC) for RPC traffic,
 * but outbox streaming MUST go through exactly ONE chosen producer.
 *
 * Flow:
 * - App boots: multiple producers may start ping loops (WS/IPС). HTTP producer is stateless.
 * - Consumers receive pongs and mark corresponding producer as connected.
 * - When EventStore wants to push a batch, it calls `streamWireWithAck()` which uses ONLY the selected streaming producer.
 * - Manager exposes helpers to inspect connected producers and which one is the streaming target.
 */
export class ProducersManager {
  private streamingProducer: BaseProducer<OutgoingMessage> | null = null;

  constructor(
    private readonly log: AppLogger,
    private _producers: BaseProducer<OutgoingMessage>[]
  ) {}

  public get producers(): BaseProducer<OutgoingMessage>[] {
    return this._producers;
  }

  public addProducer(producer: BaseProducer<OutgoingMessage>): void {
    this._producers.push(producer);
    this.log.debug(`Added producer: ${producer.transportType}`);
  }

  public removeProducer(producer: BaseProducer<OutgoingMessage>): void {
    const index = this._producers.indexOf(producer);
    if (index !== -1) {
      this._producers.splice(index, 1);
      if (this.streamingProducer === producer) this.streamingProducer = null;
      this.log.debug(`Removed producer: ${producer.transportType}`);
    }
  }

  /** Select the single producer used for outbox streaming with ACK. */
  public setStreamingProducer(producer: BaseProducer<OutgoingMessage>): void {
    if (!this._producers.includes(producer)) {
      throw new Error('Streaming producer must be registered in manager');
    }
    this.streamingProducer = producer;
    this.log.debug(`Selected streaming producer: ${producer.transportType}`);
  }

  public clearStreamingProducer(): void {
    this.streamingProducer = null;
    this.log.debug('Cleared streaming producer');
  }

  public getStreamingProducer(): BaseProducer<OutgoingMessage> | null {
    return this.streamingProducer;
  }

  /** Stream with ACK using the selected producer. Throws if none selected or not connected. */
  public async streamWireWithAck(events: WireEventRecord[], opts?: { timeoutMs?: number }): Promise<BatchAckResult> {
    const p = this.streamingProducer;
    if (!p) throw new Error('No streaming producer selected');
    if (!p.isConnected()) throw new Error('Selected streaming producer is not connected');
    return await (p as any).sendOutboxStreamBatchWithAck(events, opts);
  }

  /** Fire-and-forget broadcast to all connected producers (for RPC responses etc.). */
  public async broadcast(message: OutgoingMessage): Promise<void> {
    const connected = this._producers.filter((p) => p.isConnected());
    if (!connected.length) return;
    await Promise.allSettled(connected.map((p) => p.sendMessage(message)));
  }

  public getProducersStatus(): Array<{ name: string; connected: boolean; isStreaming?: boolean }> {
    return this._producers.map((producer) => ({
      name: producer.transportType,
      connected: producer.isConnected(),
      isStreaming: producer === this.streamingProducer,
    }));
  }

  public getConnectedCount(): number {
    return this._producers.filter((p) => p.isConnected()).length;
  }
  public getTotalCount(): number {
    return this._producers.length;
  }
  public hasConnectedProducers(): boolean {
    return this.getConnectedCount() > 0;
  }
}
