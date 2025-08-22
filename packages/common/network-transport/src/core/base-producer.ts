import type { OutgoingMessage } from '../shared';
import type { WireEventRecord } from '../shared';

export interface BatchAckResult {
  allOk: boolean;
  okIndices?: number[]; // if partial success, indices relative to sent array
}

export interface IProducer {
  sendMessage(message: OutgoingMessage, options?: any): Promise<void>;
  isConnected(): boolean;
  markPong(): void;
}

/**
 * BaseProducer **only sends** frames.
 * It also provides a promise-based API for outbox batches with ACK.
 * Incoming messages (pong, ACK, handshake) MUST be handled by a Consumer,
 * which then calls producer hooks (`markPong`, `resolveOutboxAck`, etc.).
 */
export abstract class BaseProducer<M extends OutgoingMessage = OutgoingMessage> implements IProducer {
  async sendMessage(_message: M, _options?: any): Promise<void> {
    throw new Error('The sendMessage() method is not implemented for this producer.');
  }

  /**
   * Send wire events as a batch and wait for ACK from consumer.
   * Transport-specific producer must implement this to:
   * 1) generate batchId
   * 2) send 'outboxStreamBatch'
   * 3) wait for Consumer to call `resolveOutboxAck(batchId, result)`
   * 4) resolve with {allOk | okIndices}
   */
  async sendOutboxStreamBatchWithAck(
    _events: WireEventRecord[],
    _opts?: { timeoutMs?: number }
  ): Promise<BatchAckResult> {
    throw new Error('sendOutboxStreamBatchWithAck() is not implemented for this producer.');
  }

  abstract isConnected(): boolean;
  abstract markPong(): void;

  async sendPing?(): Promise<void> {
    /* optional */
  }

  get transportType(): string {
    return this.constructor.name.replace('Producer', '').toLowerCase();
  }
}
