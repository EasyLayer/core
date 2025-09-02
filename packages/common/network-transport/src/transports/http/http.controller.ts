import { Inject, Controller, Post, Body, Headers } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import type { Envelope, QueryRequestPayload, QueryResponsePayload } from '../../shared';
import { Actions } from '../../shared';
import { BaseConsumer } from '../../core/base-consumer';

@Controller()
export class HttpController extends BaseConsumer {
  constructor(private readonly queryBus: QueryBus) {
    super();
  }

  @Post('/query')
  async handle(@Body() body: Envelope<QueryRequestPayload>, @Headers('x-transport-token') _token?: string) {
    const requestId = body?.requestId;
    const correlationId = body?.correlationId;
    const name = body?.payload?.name ?? '';

    try {
      const data = await this.executeQuery(this.queryBus, { name, dto: body?.payload?.dto });
      const resp: Envelope<QueryResponsePayload> = {
        action: Actions.QueryResponse,
        payload: { name, data },
        requestId,
        correlationId,
        timestamp: Date.now(),
      };
      return resp;
    } catch (e: any) {
      const resp: Envelope<QueryResponsePayload> = {
        action: Actions.QueryResponse,
        payload: { name, err: String(e?.message ?? e) },
        requestId,
        correlationId,
        timestamp: Date.now(),
      };
      return resp;
    }
  }

  protected async handleBusinessMessage(): Promise<void> {
    return;
  }
  protected async _send(): Promise<void> {
    return;
  }
}
