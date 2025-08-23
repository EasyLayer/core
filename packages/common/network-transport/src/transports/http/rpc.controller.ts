import { Controller, Post, Body, Headers } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { Actions, RpcRequestPayload, RpcResponsePayload } from '../../shared';
import type { Envelope } from '../../shared';

/**
 * Simple HTTP RPC controller:
 * - Optional token check via X-Transport-Token (plug if needed).
 * - Always returns 200 with RpcResponse payload (err in body if failure).
 * Complexity: O(n) over payload size; allocations = request/response JSON strings.
 */
@Controller('/rpc')
export class RpcController {
  constructor(private readonly log: AppLogger) {}

  @Post()
  async handle(@Body() body: Envelope<RpcRequestPayload>, @Headers('x-transport-token') token?: string) {
    // if (process.env.TRANSPORT_TOKEN && token !== process.env.TRANSPORT_TOKEN) {
    //   return { action: Actions.Error, payload: { err: 'unauthorized' }, timestamp: Date.now() };
    // }

    try {
      const route = body?.payload?.route ?? 'unknown';
      const data = await this.dispatch(route, body?.payload?.data);
      const resp: Envelope<RpcResponsePayload> = {
        action: Actions.RpcResponse,
        payload: { route, data },
        requestId: body?.requestId,
        correlationId: body?.correlationId,
        timestamp: Date.now(),
      };
      return resp;
    } catch (e: any) {
      const resp: Envelope<RpcResponsePayload> = {
        action: Actions.RpcResponse,
        payload: { route: body?.payload?.route ?? 'unknown', err: String(e?.message ?? e) },
        requestId: body?.requestId,
        correlationId: body?.correlationId,
        timestamp: Date.now(),
      };
      return resp;
    }
  }

  private async dispatch(route: string, data: any): Promise<any> {
    switch (route) {
      case 'health':
        return { ok: true };
      default:
        return { ok: true, route, echo: data };
    }
  }
}
