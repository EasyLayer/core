export type ContextType = 'request' | 'event' | 'batch';

export interface ContextData {
  requestId?: string;
  type: ContextType;
  batchRequestIds?: string[];
  [key: string]: any;
}
