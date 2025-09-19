import 'reflect-metadata';
import { createSnapshotsEntity } from '../snapshots.model';

describe('createSnapshotsEntity()', () => {
  it('postgres mapping', () => {
    const s = createSnapshotsEntity('postgres') as any;
    const c = s.options.columns;
    expect(c.id.type).toBe('bigserial');
    expect(c.id.primary).toBe(true);
    expect(c.id.generated).toBe(true);
    expect(c.payload.type).toBe('bytea');
    expect(c.createdAt.type).toBe('timestamp');
    expect(c.isCompressed.type).toBe('boolean');
    expect(c.isCompressed.default).toBe(false);
    expect(c.isCompressed.nullable).toBe(true);
    expect(s.options.uniques[0].columns).toEqual(['aggregateId', 'blockHeight']);
    expect(s.options.indices.map((i: any) => i.columns)).toEqual(
      expect.arrayContaining([['aggregateId', 'blockHeight'], ['blockHeight'], ['createdAt']])
    );
  });

  it('sqlite mapping', () => {
    const s = createSnapshotsEntity('sqlite') as any;
    const c = s.options.columns;
    expect(c.id.type).toBe('integer');
    expect(c.id.generated).toBe('increment');
    expect(c.payload.type).toBe('blob');
    expect(c.createdAt.type).toBe('datetime');
  });
});