import { Controller, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { WebhookStreamService } from '@easylayer/components/bitcoin-network-provider';
import { BlocksQueueLoaderService } from './blocks-loader/blocks-loader.service';
// import { Block } from './interfaces';

@Controller('blocks-queue')
export class BlocksQueueController {
  constructor(
    private readonly blocksQueueLoader: BlocksQueueLoaderService,
    private readonly webhookStreamService: WebhookStreamService
  ) {}

  // TODO: add route path to .env
  @Post('/webhook/block')
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleBlockWebhook(@Req() req: Request, @Res() res: Response) {
    return;
    // try {
    // await this.webhookStreamService.handleStream({
    //   stream: req,
    //   onDataCallback: async (block: Block) => await this.blocksQueueLoader.handleBlockFromStream(block),
    //   onFinishCallback: async () => {
    //     //
    //     await this.blocksQueueLoader.destroyStrategy();
    //     return res.status(200).send('OK');
    //   },
    //   onErrorCallback: async (error: any) => {
    //     console.error('Error processing stream:', error);
    //     await this.blocksQueueLoader.destroyStrategy();
    //     return res.status(500).send('Error processing stream');
    //   },
    // });
    // } catch (error) {
    //     res.status(500).send('Internal Server Error');
    // }
  }
}
