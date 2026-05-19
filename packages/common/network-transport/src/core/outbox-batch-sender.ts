import { Logger, Injectable } from '@nestjs/common';
import type { TransportPort } from './transport-port';
import type { Message, OutboxStreamAckPayload } from './messages';
import { Actions } from './messages';

interface WireEventRecord {
  /** Business model name that the client understands (was aggregateId/table name) */
  modelName: string;
  /** Event constructor name */
  eventType: string;
  /** Version within aggregate */
  eventVersion: number;
  requestId: string;
  blockHeight: number;
  /** Serialized JSON string (already decompressed if DB compressed it) */
  payload: string;
  /** Microseconds since epoch (monotonic, from DomainEvent.timestamp). */
  timestamp: number;
}

/**
 * Single, optional "sender" for Outbox batches. It never owns connections:
 * - Uses an injected Producer (which handles pings, SSL, connectivity, raw send).
 * - Sends wire batches and awaits a validated full ACK with a short deadline.
 * - Every outbox batch gets a correlationId; consumers must echo it in OutboxStreamAck.
 * - If no producer is set or producer is offline — throws fast for Outbox to retain rows and retry.
 */
@Injectable()
export class OutboxBatchSender {
  private logger = new Logger(OutboxBatchSender.name);
  private transport: TransportPort | null = null;
  private sendChain: Promise<void> = Promise.resolve();

  private readonly moduleName = 'network-transport';

  public setTransport(next: TransportPort | null): void {
    this.transport = next ?? null;
    this.logger.debug('Transport set', {
      module: this.moduleName,
      args: { kind: next?.kind },
    });
  }

  public getProducer(): TransportPort | null {
    return this.transport;
  }

  public hasTransport(): boolean {
    return this.transport !== null;
  }

  public async streamWireWithAck(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    const run = this.sendChain.then(
      () => this.streamWireWithAckLocked(events),
      () => this.streamWireWithAckLocked(events)
    );
    this.sendChain = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  private async streamWireWithAckLocked(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    if (!this.transport) {
      this.logger.warn('Outbox transport is not configured; batch delivery failed', {
        module: this.moduleName,
        args: { eventCount: events.length },
      });
      throw new Error('Outbox transport is not configured');
    }

    await this.transport.waitForOnline();

    const correlationId = createCorrelationId();
    const message: Message<{ events: WireEventRecord[] }> = {
      action: Actions.OutboxStreamBatch,
      payload: { events },
      correlationId,
      timestamp: Date.now(),
    };

    await this.transport.send(message);

    // ACKs are correlated and transports buffer early ACKs by correlationId.
    // Waiting after send avoids leaving a pending waiter behind if send() fails.
    const ack = await this.transport.waitForAck(undefined, correlationId);
    assertFullAck(ack, events.length, correlationId);
    return { ...ack, correlationId: ack.correlationId ?? correlationId };
  }
}

function assertFullAck(ack: OutboxStreamAckPayload, eventCount: number, expectedCorrelationId: string): void {
  if (!ack || ack.ok !== true) {
    throw new Error(`Outbox ACK failed${ack?.err ? `: ${ack.err}` : ''}`);
  }

  if (!ack.correlationId) {
    throw new Error(`Outbox ACK correlationId is missing: expected ${expectedCorrelationId}`);
  }
  if (ack.correlationId !== expectedCorrelationId) {
    throw new Error(`Outbox ACK correlation mismatch: expected ${expectedCorrelationId}, got ${ack.correlationId}`);
  }

  const okIndices = ack.okIndices;
  if (!Array.isArray(okIndices)) {
    throw new Error('Outbox ACK must include okIndices');
  }
  if (okIndices.length !== eventCount) {
    throw new Error(`Outbox ACK is partial: ${okIndices.length}/${eventCount} events acknowledged`);
  }

  const seen = new Set<number>();
  for (const index of okIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= eventCount) {
      throw new Error(`Outbox ACK contains invalid index ${index}`);
    }
    if (seen.has(index)) {
      throw new Error(`Outbox ACK contains duplicate index ${index}`);
    }
    seen.add(index);
  }

  for (let i = 0; i < eventCount; i++) {
    if (!seen.has(i)) throw new Error(`Outbox ACK is missing index ${i}`);
  }
}

function createCorrelationId(): string {
  const c: any = (globalThis as any).crypto || (globalThis as any).msCrypto;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  if (bytes.length === 16 && bytes.some((b) => b !== 0)) {
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `${toHex(bytes[0]!)}${toHex(bytes[1]!)}${toHex(bytes[2]!)}${toHex(bytes[3]!)}-${toHex(bytes[4]!)}${toHex(bytes[5]!)}-${toHex(bytes[6]!)}${toHex(bytes[7]!)}-${toHex(bytes[8]!)}${toHex(bytes[9]!)}-${toHex(bytes[10]!)}${toHex(bytes[11]!)}${toHex(bytes[12]!)}${toHex(bytes[13]!)}${toHex(bytes[14]!)}${toHex(bytes[15]!)}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
