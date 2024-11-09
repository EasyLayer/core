import { Entity, Column, Unique, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IEvent } from '@easylayer/components/cqrs';

export interface BasicEvent<T> {
  payload: BasicEventPayload & T;
}

interface BasicEventPayload {
  aggregateId: string;
  requestId?: string;
}

export interface EventDataParameters {
  aggregateId: string;
  type: string;
  payload: Record<string, any>;
  version: number;
  requestId: string;
  extra: string;
}

@Entity('events')
@Unique('UQ__request_id__aggregate_id', ['requestId', 'aggregateId'])
@Unique('UQ__version__aggregate_id', ['version', 'aggregateId'])
export class EventDataModel {
  @PrimaryGeneratedColumn()
  public id!: number;

  @Index()
  @Column({ type: 'varchar', nullable: false })
  public aggregateId!: string;

  @Column({ type: 'varchar', default: null })
  public extra!: string;

  @Column({ type: 'int', default: 0 })
  public version!: number;

  @Column({ type: 'varchar', default: null })
  public requestId!: string;

  @Column({ type: 'varchar' })
  public type!: string;

  @Column({ type: 'json' })
  public payload!: Record<string, any>;

  static deserialize({ aggregateId, type, requestId, payload }: EventDataModel): BasicEvent<IEvent> {
    const aggregateEvent: BasicEvent<IEvent> = {
      payload: {
        aggregateId,
        requestId,
        ...payload,
      },
    };

    aggregateEvent.constructor = { name: type } as typeof Object.constructor;

    return Object.assign(Object.create(aggregateEvent), aggregateEvent);
  }

  static serialize(event: Record<string, any>, version: number): EventDataModel {
    const { payload } = event;
    const { aggregateId, extra, requestId, ...rest } = payload;

    if (!aggregateId) {
      throw new Error('Aggregate Id is missed');
    }

    if (!requestId) {
      throw new Error('Request Id is missed');
    }

    if (!version) {
      throw new Error('Version is missed');
    }

    return new EventDataModel({
      aggregateId,
      version,
      requestId,
      extra,
      payload: rest,
      type: Object.getPrototypeOf(event).constructor.name,
    });
  }

  constructor(parameters: EventDataParameters) {
    if (!parameters) {
      return;
    }

    this.aggregateId = parameters.aggregateId;
    this.type = parameters.type;
    this.payload = parameters.payload;
    this.version = parameters.version;
    this.requestId = parameters.requestId;
    this.extra = parameters.extra;
  }
}
