import type { DeclarativeModel } from './types';
import { compileStateModel, type Walker } from './declarative/state-model-compiler';
import type { Model, AnyModelCtor, ZeroArgModelCtor } from './model';

export type ModelInput<T extends Model = Model> = AnyModelCtor<T> | DeclarativeModel<any>;
export type NormalizedModelCtor<T extends Model = Model> = ZeroArgModelCtor<T>;

function isClassModel(x: any): x is AnyModelCtor {
  return typeof x === 'function' && !!x.prototype && typeof x.prototype.processBlock === 'function';
}

function isDeclarative(x: any): x is DeclarativeModel<any> {
  if (!x || typeof x !== 'object') return false;
  if (typeof x.name !== 'string') return false;
  const stateOk = typeof x.state === 'function' || typeof x.state === 'object';
  return stateOk && !!x.sources && !!x.reducers;
}

function requireZeroArgCtor<T extends Model>(Ctor: AnyModelCtor<T>, modelName: string): ZeroArgModelCtor<T> {
  if (Ctor.length !== 0) throw new Error(`Model "${modelName}" must have a zero-args constructor`);
  return Ctor as ZeroArgModelCtor<T>;
}

export function normalizeModels(inputs: ModelInput[], walker: Walker): NormalizedModelCtor[] {
  return (inputs ?? []).map((item) => {
    if (isClassModel(item)) {
      const name = (item as Function).name || 'AnonymousModel';
      return requireZeroArgCtor(item, name);
    }
    if (isDeclarative(item)) {
      const compiled = compileStateModel(item, walker) as unknown as AnyModelCtor;
      return requireZeroArgCtor(compiled, item.name);
    }
    throw new Error(`Unsupported model provider: ${String(item)}`);
  });
}
