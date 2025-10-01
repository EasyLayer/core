import 'reflect-metadata';
import { createOutboxEntity } from '../outbox.model';

describe('createOutboxEntity()', () => {
  it('postgres types and flags', () => {
    const s = createOutboxEntity('postgres') as any;
    const c = s.options.columns;
    expect(c.id.type).toBe('bigint');
    expect(c.id.primary).toBe(true);
    expect(c.id.generated).toBe(false);
    expect(c.payload.type).toBe('bytea');
    expect(c.payload_uncompressed_bytes.type).toBe('bigint');
    expect(s.options.uniques[0].columns).toEqual(['aggregateId', 'eventVersion']);
    expect(s.options.indices[0].columns).toEqual(['id']);
  });

  it('sqlite types and flags', () => {
    const s = createOutboxEntity('sqlite') as any;
    const c = s.options.columns;
    expect(c.id.type).toBe('integer');
    expect(c.id.generated).toBe(false);
    expect(c.payload.type).toBe('blob');
    expect(c.payload_uncompressed_bytes.type).toBe('integer');
  });
});
