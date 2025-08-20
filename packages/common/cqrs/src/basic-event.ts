import type { IEvent } from '@nestjs/cqrs';

export enum EventStatus {
  UNSAVED = 0, // 'UNSAVED' // default status
  UNPUBLISHED = 1, //'UNPUBLISHED', // saved at db and not published
  PUBLISHED = 2, //'PUBLISHED', // published on transport
  RECEIVED = 3, //'RECEIVED', // received confirm from user
}

/**
 * System fields live on the event top level.
 * User data goes into `payload`.
 */
export type SystemFields = {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  status?: EventStatus;
  timestamp?: number;
};

/**
 * Canonical domain event envelope used everywhere.
 * `constructor.name` of the instance is the event "type".
 */
export type DomainEvent<P = any> = IEvent &
  SystemFields & {
    payload: P;
  };

export abstract class BasicEvent<P = any> implements DomainEvent<P> {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  status: EventStatus;
  timestamp: number;

  constructor(
    systemFields: SystemFields,
    public readonly payload: P
  ) {
    this.aggregateId = systemFields.aggregateId;
    this.requestId = systemFields.requestId;
    this.blockHeight = systemFields.blockHeight;
    this.status = EventStatus.UNSAVED;
    this.timestamp = Date.now();
  }
}
