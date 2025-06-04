import type { AppLogger } from '@easylayer/common/logger';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from '../load-strategies';
import type { BlocksQueue } from '../../blocks-queue';

export class SubscribeBlocksProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.SUBSCRIBE;

  // Hold the active subscription (Promise<void> & { unsubscribe(): void }) or undefined
  private _subscription?: Promise<void> & { unsubscribe: () => void };

  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: any
  ) {
    // No special config needed here
  }

  /**
   * Sets up a WebSocket‐based subscription to new blocks.
   * If already subscribed, it simply returns.
   *
   * For every incoming block:
   * 1. If block.blockNumber ≤ queue.lastHeight, skip it.
   * 2. Otherwise, enqueue it.
   *
   * NOTE: We do NOT await the subscription call here—otherwise `await` would unwrap the promise
   *       into `void` and we'd lose the `unsubscribe()` method.
   */
  public async load(): Promise<void> {
    if (this._subscription) {
      this.log.debug(`Already subscribed to new blocks`);
      return;
    }

    try {
      // Call subscribeToNewBlocks(…) and store its return‐value (the promise object, which has `unsubscribe()`)
      this._subscription = this.blockchainProvider.subscribeToNewBlocks(async (block: Block) => {
        try {
          if (block.blockNumber <= this.queue.lastHeight) {
            this.log.debug(`Skipping block ${block.blockNumber} (<= lastHeight ${this.queue.lastHeight})`);
            return;
          }
          await this.queue.enqueue(block);
        } catch (enqueueErr) {
          this.log.error(`Failed to enqueue block ${block.blockNumber}`, { args: { error: enqueueErr } });
        }
      });

      this.log.debug(`Subscription created (waiting for new blocks)`);
    } catch (syncErr) {
      // In practice, `subscribeToNewBlocks(...)` is `async`, so most errors inside it come back as a rejection,
      // not a synchronous throw. This catch only catches truly‐synchronous errors before the function returns.
      this.log.error(`subscribeToNewBlocks threw synchronously`, { args: { error: syncErr }, methodName: 'load' });
      throw syncErr;
    }

    // Also attach a .catch(...) so that if the underlying promise ever rejects, we log it:
    this._subscription.catch((err) => {
      this.log.error(`${this.name}: Subscription promise rejected`, { args: err });
      // Clear _subscription so that a future load() can try again:
      this._subscription = undefined;
    });
  }

  /**
   * Cancels the existing subscription (if any). Calls `unsubscribe()` on the stored promise,
   * which removes the WebSocket listener and resolves that promise.
   */
  public async stop(): Promise<void> {
    if (!this._subscription) {
      this.log.debug('No active subscription to stop');
      return;
    }

    try {
      this._subscription.unsubscribe();
      this.log.debug('Unsubscribed from new blocks');
    } catch (error) {
      this.log.error('Error while unsubscribing', {
        args: { error },
        methodName: 'stop',
      });
    } finally {
      this._subscription = undefined;
    }
  }
}
