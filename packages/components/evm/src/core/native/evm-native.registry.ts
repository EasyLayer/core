import type { NativeEvmBindings } from './interfaces';

let bindings: NativeEvmBindings | undefined;
let loadError: Error | undefined;

export function setEvmNativeBindings(next: NativeEvmBindings | undefined): void {
  bindings = next;
  loadError = undefined;
}

export function setEvmNativeLoadError(error: Error): void {
  bindings = undefined;
  loadError = error;
}

export function getEvmNativeBindings(): NativeEvmBindings | undefined {
  return bindings;
}

export function getEvmNativeLoadError(): Error | undefined {
  return loadError;
}

export function isEvmNativeAvailable(): boolean {
  return Boolean(bindings?.NativeBlocksQueue && bindings?.NativeEvmMempoolState);
}
