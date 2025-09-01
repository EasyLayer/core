import type { DeclarativeModel } from './types';
import { compileStateModel, type Walker } from './declarative/state-model-compiler';
import type { Model } from './model';
import type { ModelCtor } from './model';

/** Normalized ctor type returned by `normalizeModels` */
export type NormalizedModelCtor<T extends Model = Model> = ModelCtor<T>;
/** Public union type: a class (subclass of Model) or a declarative descriptor. */
export type ModelInput<T extends Model = Model> = ModelCtor<T> | DeclarativeModel<any>;

/** Runtime type guard: class-based model (subclass of Model) */
function isClassModel(x: any): x is ModelCtor {
  return typeof x === 'function' && !!x.prototype && typeof x.prototype.processBlock === 'function';
}

/** Runtime type guard: declarative model */
function isDeclarative(x: any): x is DeclarativeModel<any> {
  if (!x || typeof x !== 'object') return false;
  if (typeof x.name !== 'string') return false;
  const stateOk = typeof x.state === 'function' || typeof x.state === 'object';
  return stateOk && !!x.sources && !!x.reducers;
}

/** Convert a mixed list of models into class constructors uniformly */
export function normalizeModels(inputs: ModelInput[], walker: Walker): NormalizedModelCtor[] {
  return (inputs ?? []).map((item) => {
    if (isClassModel(item)) {
      return item as NormalizedModelCtor;
    }
    if (isDeclarative(item)) {
      const compiled = compileStateModel(item, walker);
      return compiled as unknown as NormalizedModelCtor;
    }
    throw new Error(`Unsupported model provider: ${String(item)}`);
  });
}
