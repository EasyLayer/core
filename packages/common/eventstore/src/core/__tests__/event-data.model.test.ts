import 'reflect-metadata';
import { createEventDataEntity } from '../event-data.model';

describe('createEventDataEntity()', () => {
  it('postgres types and flags', () => {
    const s = createEventDataEntity('agg_ev', 'postgres') as any;
    const c = s.options.columns;
    expect(c.id.type).toBe('bigserial');
    expect(c.id.generated).toBe(true);
    expect(c.payload.type).toBe('bytea');
    expect(c.blockHeight.nullable).toBe(true);
    expect(c.blockHeight.default).toBeNull();
    const uniques = s.options.uniques[0];
    const indices = s.options.indices[0];
    expect(uniques.columns).toEqual(['version', 'requestId']);
    expect(indices.columns).toEqual(['blockHeight']);
  });

  it('sqlite types and flags', () => {
    const s = createEventDataEntity('agg_ev', 'sqlite') as any;
    const c = s.options.columns;
    expect(c.id.type).toBe('integer');
    expect(c.id.generated).toBe('increment');
    expect(c.payload.type).toBe('blob');
  });
});
