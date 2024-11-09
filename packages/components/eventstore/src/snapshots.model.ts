import { Entity, Column, PrimaryColumn } from 'typeorm';
import { AggregateRoot } from '@easylayer/components/cqrs';

export interface SnapshotParameters {
  aggregateId: string;
  payload: string;
}

@Entity('snapshots')
export class SnapshotsModel {
  @PrimaryColumn({ type: 'varchar' })
  public aggregateId!: string;

  @Column({ type: 'text' })
  public payload!: string;

  static toSnapshot<T extends AggregateRoot & { aggregateId: string }>(aggregate: T): SnapshotsModel {
    const { aggregateId } = aggregate;

    if (!aggregateId) {
      throw new Error('Aggregate Id is missed');
    }

    // Serialize the payload as a JSON string
    const payload = aggregate.toSnapshotPayload();

    return new SnapshotsModel({
      aggregateId,
      payload,
    });
  }

  constructor(parameters: SnapshotParameters) {
    if (!parameters) {
      return;
    }

    this.aggregateId = parameters.aggregateId;
    this.payload = parameters.payload;
  }
}
