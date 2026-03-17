import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { BlockchainProviderService, MempoolTxMetadata } from '../blockchain-provider';
import type { MempoolCommandExecutor } from './interfaces';

/**
 * Stateless loader (no local snapshot/state):
 * - On trigger, fetch providers' verbose mempool.
 * - Deduplicate txids across providers (first provider wins).
 * - Build per-provider payload WITHOUT any fee logic (filtering/sorting by fee is domain logic).
 * - Dispatch a single LoadSnapshot command to the aggregate (aggregate handles recursion via events).
 *
 * Concurrency policy:
 * - Single boolean lock. While locked, new triggers are ignored (latest-wins by dropping overlaps).
 * - External consumer MUST call `unlock()` when the cycle under this snapshot is finished.
 */
@Injectable()
export class MempoolLoaderService implements OnModuleInit {
  private readonly log = new Logger(MempoolLoaderService.name);
  private readonly moduleName = 'blocks-queue';

  // Enable switch (off by default; flip via start()).
  private enabled = false;

  // Single lock: true ⇒ a cycle is currently running under the last dispatched snapshot.
  private locked = false;

  constructor(
    private readonly provider: BlockchainProviderService,
    @Inject('MempoolCommandExecutor')
    private readonly executor: MempoolCommandExecutor
  ) {}

  onModuleInit() {
    this.log.verbose('Mempool loader service initialized', {
      module: this.moduleName,
    });
  }

  /** One-time flip to enable the synchronizer. Idempotent. */
  public start(): void {
    if (!this.enabled) {
      this.enabled = true;
      this.log.verbose('Mempool refresh enabled', {
        module: this.moduleName,
      });
    }
  }

  /** External signal that current cycle is finished → allow next refresh. */
  public unlock(): void {
    if (this.locked) {
      this.locked = false;
      this.log.verbose('Mempool refresh unlocked', {
        module: this.moduleName,
      });
    }
  }

  /**
   * Public trigger (loader tick / blocks confirmed / reorg / manual).
   * Rules:
   *  - If disabled → return silently.
   *  - If locked → drop this trigger (ignore overlaps).
   *  - Else:
   *      fetch providers, deduplicate across providers, dispatch one LoadSnapshot command.
   *      If dispatch succeeds → set locked=true (domain will eventually call unlock()).
   *      If dispatch fails → DO NOT lock (let the next trigger retry).
   */
  public async refresh(height: number): Promise<void> {
    if (!this.enabled) return;
    if (this.locked) {
      this.log.verbose('Mempool refresh skipped because previous cycle is still in progress', {
        module: this.moduleName,
      });
      return;
    }

    // 1) Fetch raw snapshots from all providers.
    this.log.verbose('Mempool refresh started', {
      module: this.moduleName,
      args: { height },
    });

    const raw = await this.provider.getRawMempoolFromAll(true);

    // 2) Deduplicate across providers (no fee logic here).
    const perProvider = this.buildPerProvider(raw);

    // 3) Dispatch one command; lock only if we successfully dispatched.
    try {
      await this.executor.handleSnapshot({
        requestId: uuidv4(),
        height,
        perProvider,
      });
      this.locked = true;
      this.log.verbose('Mempool snapshot dispatched and loader locked', {
        module: this.moduleName,
        args: { height, providers: Object.keys(perProvider).length },
      });
    } catch (e) {
      this.log.verbose('Failed to dispatch mempool snapshot, will retry on next trigger', {
        module: this.moduleName,
        args: {
          height,
          action: 'refresh',
          error: (e as any)?.message ?? String(e),
        },
      });
    }
  }

  /**
   * Build provider → [{ txid, metadata }] with global deduplication only.
   *
   * Algorithm:
   *  - Maintain a global Set<string> `seen` of txids.
   *  - Iterate providers in the given order:
   *      • For each own txid→metadata pair:
   *          – If txid is already in `seen` → skip (first provider wins).
   *          – Else push { txid, metadata } to this provider’s list and mark `seen`.
   *  - No fee filtering. No sorting by fee. No mutations of metadata.
   *
   * Complexity:
   *  - Let P be number of providers, N the total txids scanned.
   *  - Time: O(P + N) single pass.
   *  - Space: O(U) where U is the number of unique txids (U ≤ N).
   */
  private buildPerProvider(
    raw: Array<{ providerName: string; value: unknown }>
  ): Record<string, Array<{ txid: string; metadata: MempoolTxMetadata }>> {
    const out: Record<string, Array<{ txid: string; metadata: MempoolTxMetadata }>> = {};
    const seen = new Set<string>();

    for (const { providerName, value } of raw) {
      if (!providerName) continue;
      if (!value || typeof value !== 'object') continue;

      const metaMap = value as Record<string, MempoolTxMetadata>;
      const buf: Array<{ txid: string; metadata: MempoolTxMetadata }> = [];

      for (const [txid, metadata] of Object.entries(metaMap)) {
        if (seen.has(txid)) continue;
        seen.add(txid);
        buf.push({ txid, metadata });
      }

      if (buf.length > 0) {
        out[providerName] = buf;
      }
    }

    this.log.verbose('Per-provider snapshot built', {
      module: this.moduleName,
      args: {
        providers: Object.keys(out).length,
        totalTxids: Object.values(out).reduce((sum, arr) => sum + arr.length, 0),
      },
    });

    return out;
  }
}
