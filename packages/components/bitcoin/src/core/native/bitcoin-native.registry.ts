import type { NativeBitcoinBindings, NativeMempoolStateConstructor, NativeMerkleVerifier } from './interfaces';

export class BitcoinNativeRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BitcoinNativeRuntimeError';
  }
}

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

function nativeRequiredMessage(component: string): string {
  const reason = loadError ? ` Native load error: ${loadError.message}` : ' Native bindings are not registered.';
  return `${component} requires the Bitcoin Rust native addon in Node.js runtime; JavaScript fallback is disabled.${reason}`;
}

export function requireBitcoinNativeBindings(component = 'Bitcoin native component'): NativeBitcoinBindings {
  if (!bindings) {
    throw new BitcoinNativeRuntimeError(nativeRequiredMessage(component));
  }
  return bindings;
}

export function requireBitcoinNativeMempoolState(): NativeMempoolStateConstructor {
  const NativeMempoolState = requireBitcoinNativeBindings('NativeMempoolState').NativeMempoolState;
  if (!NativeMempoolState) {
    throw new BitcoinNativeRuntimeError(nativeRequiredMessage('NativeMempoolState'));
  }
  return NativeMempoolState;
}

export function requireBitcoinNativeMerkleVerifier(): NativeMerkleVerifier {
  const NativeMerkleVerifier = requireBitcoinNativeBindings('NativeMerkleVerifier').NativeMerkleVerifier;
  if (!NativeMerkleVerifier) {
    throw new BitcoinNativeRuntimeError(nativeRequiredMessage('NativeMerkleVerifier'));
  }
  return NativeMerkleVerifier;
}

/**
 * Returns true when at least one Bitcoin native component is registered.
 *
 * This helper is diagnostic only. Runtime code must use the component-specific
 * require* helpers above so missing/incomplete Rust bindings fail explicitly
 * instead of falling back to JavaScript.
 */
export function isBitcoinNativeAvailable(): boolean {
  return isBitcoinNativeMempoolStateAvailable() || isBitcoinNativeMerkleVerifierAvailable();
}

export function isBitcoinNativeMempoolStateAvailable(): boolean {
  return Boolean(bindings?.NativeMempoolState);
}

export function isBitcoinNativeMerkleVerifierAvailable(): boolean {
  return Boolean(bindings?.NativeMerkleVerifier);
}
