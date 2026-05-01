import type { NativeBitcoinBindings } from './interfaces';

let bindings: NativeBitcoinBindings | undefined;
let loadError: Error | undefined;

export function setBitcoinNativeBindings(next: NativeBitcoinBindings | undefined): void {
  bindings = next;
  loadError = undefined;
}

export function setBitcoinNativeLoadError(error: Error): void {
  bindings = undefined;
  loadError = error;
}

export function getBitcoinNativeBindings(): NativeBitcoinBindings | undefined {
  return bindings;
}

export function getBitcoinNativeLoadError(): Error | undefined {
  return loadError;
}

export function isBitcoinNativeAvailable(): boolean {
  return Boolean(bindings?.NativeBlocksQueue && bindings?.NativeMempoolState);
}
