export interface INetworkTransportService {
  executeQuery<T>(queryName: string, query: any): Promise<T>;
}
