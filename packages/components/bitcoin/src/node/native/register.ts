import { setBitcoinNativeBindings, setBitcoinNativeLoadError } from '../../core/native';
import { loadBitcoinNativeBindings } from './loader';

try {
  const bindings = loadBitcoinNativeBindings();
  if (bindings) {
    setBitcoinNativeBindings(bindings);
  }
} catch (error: unknown) {
  setBitcoinNativeLoadError(error instanceof Error ? error : new Error(String(error)));
}
