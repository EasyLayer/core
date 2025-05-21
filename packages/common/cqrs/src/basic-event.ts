import type { IEvent } from '@nestjs/cqrs';

export interface EventBasePayload {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
}

export class BasicEvent<P extends EventBasePayload> implements IEvent {
  constructor(public readonly payload: P) {}
}
