import { setEvmNativeBindings, setEvmNativeLoadError } from '../../core/native';
import { loadEvmNativeBindings } from './loader';

try {
  const bindings = loadEvmNativeBindings();
  if (bindings) {
    setEvmNativeBindings(bindings);
  }
} catch (error: unknown) {
  setEvmNativeLoadError(error instanceof Error ? error : new Error(String(error)));
}
