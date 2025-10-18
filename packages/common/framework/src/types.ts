/** Network-agnostic execution context (network packages may extend it). */
export interface ExecutionContext<NetBlock = unknown> {
  block: NetBlock;
  [k: string]: any;
}
