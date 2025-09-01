import { StateModel } from './state-model';
import type { DeclarativeModel, ExecutionContext, SourceSpec } from '../types';
import type { Model } from '../model';

/** Compiled (declarative) model constructor: instance IS a Model, plus `.state`. */
export type CompiledModelClass<State, T extends Model = Model> = {
  new (aggregateId: string, lastBlockHeight: number, override?: { options?: any }): T & { state: State };
  modelName: string;
};

export type Walker = (from: string, block: any, fn: (ctx: any) => void | Promise<void>) => Promise<void>;

/** Normalizes initial state descriptor to a factory function. */
function asFactory<State>(state: State | (() => State)): () => State {
  return typeof state === 'function' ? (state as () => State) : () => state as State;
}

export function compileStateModel<State>(
  declarative: DeclarativeModel<State>,
  walker: Walker
): CompiledModelClass<State, Model> {
  const { name: modelName, state, reducers, sources, options } = declarative;
  const makeState = asFactory(state);

  class Compiled extends StateModel<State> {
    static modelName = modelName;

    constructor(aggregateId: string = modelName, lastBlockHeight: number = -1, override?: { options?: any }) {
      const mergedOptions = { ...(options ?? {}), ...(override?.options ?? {}) };
      super(aggregateId, lastBlockHeight, { ...mergedOptions, initialState: makeState });

      for (const [eventName, reducer] of Object.entries(reducers ?? {})) {
        const bound = (e: any) => (reducer as any).call(this, e);
        Object.defineProperty(this, `on${eventName}`, {
          value: bound,
          writable: false,
          enumerable: false,
          configurable: true,
        });
      }
    }

    /**
     * Walks source streams and invokes source handlers.
     * - Avoids deep/shallow copies: creates a thin wrapper with `ctx` as prototype.
     * - Injects `state` and `applyEvent` as non-writable properties.
     * - Chains each sub-context prototype to the prepared base context.
     */
    public async processBlock(ctx: ExecutionContext): Promise<void> {
      const { block } = ctx ?? {};
      if (!block) return;

      const boundApplyEvent = this.applyEvent.bind(this);

      const baseCtx = Object.create(ctx);
      Object.defineProperty(baseCtx, 'state', { value: this.state, writable: false, enumerable: false });
      Object.defineProperty(baseCtx, 'applyEvent', { value: boundApplyEvent, writable: false, enumerable: false });

      const list = Object.values(sources ?? {}) as SourceSpec<State>[];
      for (const src of list) {
        await walker(src.from, block, (subctx: any) => {
          Object.setPrototypeOf(subctx, baseCtx);
          return src.handler(subctx);
        });
      }
    }
  }

  Object.defineProperty(Compiled, 'name', { value: `${modelName}Model` });

  return Compiled as unknown as CompiledModelClass<State, Model>;
}
