import type { Message, OutboxStreamAckPayload, TransportKind } from './messages';

export interface TransportPort {
  readonly kind: TransportKind;
  isOnline(): boolean;
  waitForOnline(deadlineMs?: number): Promise<void>;
  send(msg: Message): Promise<void>;
  /**
   * Waits for an ACK frame from the remote consumer.
   *
   * CONTRACT: Every implementation MUST enforce an internal deadline and reject
   * with an error if no ACK arrives within that deadline. Leaving waitForAck()
   * without a timeout will cause the outbox drain to hang indefinitely, which
   * stops the crawler from processing new blocks.
   *
   * The optional deadlineMs parameter allows the caller to override the default
   * transport deadline. If not provided, the transport uses its own configured default.
   *
   * @param deadlineMs - Optional override for the transport's default ACK deadline.
   * @param correlationId - Batch correlation id for outbox delivery. Outbox ACKs must carry the same id in the message envelope or ACK payload.
   */
  waitForAck(deadlineMs?: number, correlationId?: string): Promise<OutboxStreamAckPayload>;
}
