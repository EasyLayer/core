import type { NativeBitcoinBindings } from '../../core/native';
import { setBitcoinNativeBindings } from '../../core/native';

/**
 * Browser hook for a future WASM implementation.
 * Node native loading is intentionally not imported from the browser entry.
 */
export async function registerBitcoinWasmBindings(bindings: NativeBitcoinBindings): Promise<void> {
  setBitcoinNativeBindings(bindings);
}

export * from '../../core/native';
