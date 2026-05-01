import type { NativeEvmBindings } from '../../core/native';
import { setEvmNativeBindings } from '../../core/native';

/**
 * Browser hook for a future WASM implementation.
 * Node N-API loading is intentionally not imported from the browser entry.
 */
export async function registerEvmWasmBindings(bindings: NativeEvmBindings): Promise<void> {
  setEvmNativeBindings(bindings);
}

export * from '../../core/native';
