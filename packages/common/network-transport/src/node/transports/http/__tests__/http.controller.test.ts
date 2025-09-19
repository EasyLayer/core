import type { Envelope, QueryRequestPayload, QueryResponsePayload } from '../../../../core';
import { Actions } from '../../../../core';
import { HttpController } from '../http.controller';

describe('HttpController', () => {
  it('returns QueryResponse with data and preserves ids', async () => {
    const queryBus = { execute: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new HttpController(queryBus as any);

    const req: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      payload: { name: 'Health', dto: { a: 1 } },
      requestId: 'rid-1',
      correlationId: 'cid-1',
      timestamp: Date.now(),
    };

    const res = (await controller.handle(req)) as Envelope<QueryResponsePayload>;
    expect(res.action).toBe(Actions.QueryResponse);
    expect(res.requestId).toBe('rid-1');
    expect(res.correlationId).toBe('cid-1');
    expect(res.payload?.name).toBe('Health');
    expect(res.payload?.data).toEqual({ ok: true });
    expect(typeof res.timestamp).toBe('number');
  });

  it('returns QueryResponse with err on execute failure', async () => {
    const queryBus = { execute: jest.fn().mockRejectedValue(new Error('boom')) };
    const controller = new HttpController(queryBus as any);

    const req: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      payload: { name: 'GetX', dto: { x: 1 } },
      requestId: 'r2',
      correlationId: 'c2',
      timestamp: Date.now(),
    };

    const res = (await controller.handle(req)) as Envelope<QueryResponsePayload>;
    expect(res.action).toBe(Actions.QueryResponse);
    expect(res.requestId).toBe('r2');
    expect(res.correlationId).toBe('c2');
    expect(res.payload?.name).toBe('GetX');
    expect(typeof res.payload?.err).toBe('string');
  });
});
