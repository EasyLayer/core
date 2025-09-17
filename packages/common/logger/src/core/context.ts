export type ContextType = 'request' | 'event' | 'batch';

export interface ContextData {
  requestId?: string;
  batchRequestIds?: string[];
  type?: string;
  [k: string]: any;
}
