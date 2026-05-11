/**
 * Execution context passed to `Model.processBlock()`.
 *
 * Intentionally untyped (any-map) — the exact set of fields depends on the
 * blockchain chain (Bitcoin, EVM, etc.) and is defined by the downstream
 * crawler package, not by the framework itself.
 *
 * Downstream packages should define their own typed context and cast or narrow
 * when implementing `processBlock`:
 *
 * @example
 * ```typescript
 * // In a Bitcoin crawler model:
 * interface BitcoinExecutionContext extends ExecutionContext {
 *   block: BitcoinBlock;
 *   network: NetworkState;
 * }
 *
 * public async processBlock(ctx: ExecutionContext): Promise<void> {
 *   const { block, network } = ctx as BitcoinExecutionContext;
 *   // ...
 * }
 * ```
 *
 * Changing this to a strict typed interface here would break cross-chain
 * compatibility. Type safety for context fields is the responsibility of
 * each chain-specific crawler implementation.
 */
export interface ExecutionContext {
  [k: string]: any;
}
