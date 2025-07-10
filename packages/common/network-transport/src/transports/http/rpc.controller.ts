import {
  Controller,
  HttpCode,
  Header,
  UsePipes,
  ValidationPipe,
  Post,
  Body,
  Inject,
  HttpException,
  HttpStatus,
  Get,
} from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseConsumer } from '../../core/base-consumer';
import {
  BasePayload,
  OutgoingMessage,
  BadRequestError,
  NotFoundError,
  MESSAGE_SIZE_LIMITS,
  validateMessageSize,
} from '../../shared';
import type { IncomingMessage } from '../../shared';
import type { HttpServerOptions } from './http.module';

@Controller()
// @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class RpcController extends BaseConsumer {
  private readonly maxMessageSize: number;

  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus,
    private readonly log: AppLogger,
    @Inject('HTTP_OPTIONS')
    private readonly options: HttpServerOptions
  ) {
    super();
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.HTTP;
  }

  @Get('health')
  health() {
    return { status: 'ok', timestamp: Date.now() };
  }

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  async handle(@Body() request: IncomingMessage<'query', BasePayload>): Promise<OutgoingMessage> {
    const { requestId, action, payload } = request;

    this.log.debug('Received HTTP RPC request', {
      args: { requestId, action, payload },
    });

    try {
      // Validate message size
      validateMessageSize(request, this.maxMessageSize, 'http', this.options.name || 'http');

      if (!this.validateMessage(request)) {
        throw new BadRequestError('Invalid message format');
      }

      if (action === 'query') {
        if (!this.validateQueryPayload(payload)) {
          throw new BadRequestError('Missing or invalid payload for query');
        }

        const { dto, constructorName } = payload;

        this.log.debug('Executing HTTP query', {
          args: { constructorName, dto },
        });

        const result = await this.executeQuery(this.queryBus, { constructorName, dto });

        this.log.debug('HTTP query executed successfully', {
          args: { result },
        });

        return this.createResponse('queryResponse', result, requestId);
      }

      throw new BadRequestError(`Unsupported action: ${action}`);
    } catch (err: any) {
      this.log.error('Error during HTTP query execution', {
        args: { error: err.message, requestId, stack: err.stack },
      });

      // Convert transport errors to HTTP exceptions
      if (err instanceof BadRequestError) {
        throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
      }

      if (err instanceof NotFoundError) {
        throw new HttpException(err.message, HttpStatus.NOT_FOUND);
      }

      return this.createErrorResponse(err, requestId);
    }
  }
}
