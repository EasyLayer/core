import type { Message, OutboxStreamAckPayload, TransportKind } from './messages';

export interface TransportPort {
  readonly kind: TransportKind;
  isOnline(): boolean;
  waitForOnline(deadlineMs?: number): Promise<void>;
  send(msg: Message): Promise<void>;
  waitForAck(deadlineMs?: number): Promise<OutboxStreamAckPayload>;
}
