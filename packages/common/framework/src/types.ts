import type { AggregateOptions } from '@easylayer/common/cqrs';

/** Network-agnostic execution context (network packages may extend it). */
export interface ExecutionContext<NetBlock = unknown> {
  block: NetBlock;
  [k: string]: any;
}

/** Context passed to source handlers in declarative models. */
export type SourceSelectCtx<State = any> = Readonly<ExecutionContext> & {
  state: Readonly<State>;
  applyEvent: (eventName: string, blockHeight: number, payload?: any) => Promise<void> | void;
};

/** Source spec (per-network walker routes by "from"). */
export type SourceSpec<State = any> = {
  from: string;
  handler: (ctx: SourceSelectCtx<State>) => void | Promise<void>;
};

/** Reducers map: on<Event> equivalent in declarative form. */
export type ReducersMap = Record<string, (this: any, e: any) => void>;

/** Declarative model: state can be a factory or a plain object. */
export interface DeclarativeModel<State = any> {
  name: string;
  state: State | (() => State);
  sources: Record<string, SourceSpec<State>>;
  reducers: ReducersMap;
  options?: AggregateOptions;
}
