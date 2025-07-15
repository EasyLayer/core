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
    const protocol = this.options.ssl?.enabled ? 'https' : 'http';
    const port = this.options.port || 3000;
    const host = this.options.host || '0.0.0.0';

    return {
      status: 'ok',
      timestamp: Date.now(),
      server: {
        protocol,
        host,
        port,
        ssl: this.options.ssl?.enabled || false,
      },
    };
  }

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/json')
  async handle(@Body() request: IncomingMessage<'query', BasePayload>): Promise<OutgoingMessage> {
    const { requestId, action, payload } = request;

    this.log.debug('Received HTTP RPC request', {
      args: {
        requestId,
        action,
        payload,
        ssl: this.options.ssl?.enabled || false,
      },
    });

    try {
      // Validate message size
      validateMessageSize(request, this.maxMessageSize, 'http');

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

        return this.createResponse('queryResponse', this.normalizeResult(result), requestId);
      }

      throw new BadRequestError(`Unsupported action: ${action}`);
    } catch (err: any) {
      this.log.error('Error during HTTP query execution', {
        args: {
          error: err.message,
          requestId,
          stack: err.stack,
          ssl: this.options.ssl?.enabled || false,
        },
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

  private normalizeResult(result: any) {
    if (
      result &&
      typeof result === 'object' &&
      typeof result.payload === 'string' &&
      result.payload.trim().startsWith('{')
    ) {
      try {
        return { ...result, payload: JSON.parse(result.payload) };
      } catch {
        /* leave as-is if broken JSON */
      }
    }
    return result;
  }
}
