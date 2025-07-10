import { Controller, HttpCode, Header, Post, Body, Res, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import type { Response } from 'express';
import { BaseConsumer } from '../../core/base-consumer';
import { BasePayload, BadRequestError, NotFoundError, MESSAGE_SIZE_LIMITS, validateMessageSize } from '../../shared';
import type { IncomingMessage } from '../../shared';
import type { HttpServerOptions } from './http.module';

@Controller('stream')
export class StreamController extends BaseConsumer {
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

  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/x-ndjson')
  async handleStreamQuery(
    @Body() request: IncomingMessage<'streamQuery', BasePayload>,
    @Res() res: Response
  ): Promise<void> {
    const { requestId, action, payload } = request;

    this.log.debug('Received HTTP streaming request', {
      args: { requestId, action, payload },
    });

    try {
      // Validate message size
      validateMessageSize(request, this.maxMessageSize, 'http', this.options.name || 'http');

      if (!this.validateMessage(request)) {
        throw new BadRequestError('Invalid message format');
      }

      if (action === 'streamQuery') {
        if (!this.validateQueryPayload(payload)) {
          throw new BadRequestError('Missing or invalid payload for query');
        }

        this.log.debug('Executing HTTP streaming query', {
          args: { constructorName: payload.constructorName, dto: payload.dto },
        });

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
        });

        try {
          const streamGenerator = this.handleStreamingQuery(this.queryBus, payload);

          for await (const responseMessage of streamGenerator) {
            const responseWithId = { ...responseMessage, requestId };
            res.write(JSON.stringify(responseWithId) + '\n');
          }

          const endMessage = this.createResponse('streamEnd', undefined, requestId);
          res.write(JSON.stringify(endMessage) + '\n');
          res.end();
        } catch (streamError: any) {
          this.log.error('Error during HTTP streaming', {
            args: { error: streamError.message, requestId },
          });

          const errorResponse = this.createErrorResponse(streamError, requestId);
          res.write(JSON.stringify(errorResponse) + '\n');
          res.end();
        }

        return;
      }

      throw new BadRequestError('Streaming not supported for this action');
    } catch (err: any) {
      this.log.error('Error during HTTP streaming query setup', {
        args: { error: err.message, requestId, stack: err.stack },
      });

      // Convert transport errors to HTTP exceptions for non-streaming errors
      if (err instanceof BadRequestError) {
        throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
      }

      if (err instanceof NotFoundError) {
        throw new HttpException(err.message, HttpStatus.NOT_FOUND);
      }

      const errorResponse = this.createErrorResponse(err, requestId);
      res.status(500).json(errorResponse);
    }
  }
}
