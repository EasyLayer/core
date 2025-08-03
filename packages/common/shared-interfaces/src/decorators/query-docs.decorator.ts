import 'reflect-metadata';

export interface QueryDocMetadata {
  description: string;
  category: string;
  streaming?: boolean;
  examples?: {
    request?: any;
    response?: any;
  };
}

export const QUERY_DOC_METADATA_KEY = Symbol('queryDoc');

export function QueryDoc(metadata: QueryDocMetadata) {
  return function (target: any) {
    Reflect.defineMetadata(QUERY_DOC_METADATA_KEY, metadata, target);
  };
}
