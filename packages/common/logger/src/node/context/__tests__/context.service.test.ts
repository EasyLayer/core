import { ContextService } from '../../../../eventstore/src/node/context/context.service';
import { ContextData } from '../../interfaces';

describe('ContextService', () => {
  let service: ContextService;

  beforeEach(() => {
    service = new ContextService();
  });

  it('should store and retrieve values within run()', () => {
    const data: ContextData = { requestId: 'abc', type: 'request', extra: 42 };
    service.run(data, () => {
      expect(service.get('requestId')).toBe('abc');
      expect(service.get('type')).toBe('request');
      expect(service.get('extra')).toBe(42);
    });
  });

  it('should not retain context outside run()', () => {
    expect(service.get('requestId')).toBeUndefined();
    expect(service.get('type')).toBeUndefined();
  });

  it('should isolate contexts for parallel runs', done => {
    const results: string[] = [];
    service.run({ requestId: '1', type: 'request' }, () => {
      setTimeout(() => {
        results.push(service.get('requestId')!);
        if (results.length === 2) {
          expect(results.sort()).toEqual(['1', '2']);
          done();
        }
      }, 20);
    });
    service.run({ requestId: '2', type: 'event' }, () => {
      setTimeout(() => {
        results.push(service.get('requestId')!);
        if (results.length === 2) {
          expect(results.sort()).toEqual(['1', '2']);
          done();
        }
      }, 10);
    });
  });

  it('bind should preserve context for callback', done => {
    service.run({ requestId: 'bind', type: 'event' }, () => {
      const bound = service.bind(() => {
        expect(service.get('requestId')).toBe('bind');
        done();
      });
      // Call bound callback outside run
      setTimeout(bound, 15);
    });
  });

  it('init should set context for subsequent calls', () => {
    service.init('init-id', 'request');
    expect(service.get('requestId')).toBe('init-id');
    expect(service.get('type')).toBe('request');
  });
});