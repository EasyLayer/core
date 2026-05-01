export interface JsonRpcRequest {
  method: string;
  params: any[];
}

export interface JsonRpcTransport {
  request<T = any>(method: string, params?: any[]): Promise<T>;
  batch<T = any>(requests: JsonRpcRequest[]): Promise<Array<T | null>>;
  close(): Promise<void> | void;
}
