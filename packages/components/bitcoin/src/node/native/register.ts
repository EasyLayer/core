import { setBitcoinNativeBindings, setBitcoinNativeLoadError } from '../../core/native';
import type { NativeBitcoinBindings, NativeMerkleVerifier } from '../../core/native';
import { loadBitcoinNativeBindings } from './loader';

function missingRequiredExports(raw: any): string[] {
  const missing: string[] = [];
  if (!raw?.NativeMempoolState) missing.push('NativeMempoolState');
  if (typeof raw?.bitcoinComputeMerkleRoot !== 'function') missing.push('bitcoinComputeMerkleRoot');
  if (typeof raw?.bitcoinVerifyMerkleRoot !== 'function') missing.push('bitcoinVerifyMerkleRoot');
  if (typeof raw?.bitcoinVerifyWitnessCommitment !== 'function') missing.push('bitcoinVerifyWitnessCommitment');
  return missing;
}

try {
  const raw = loadBitcoinNativeBindings() as any;
  if (!raw) {
    throw new Error('Bitcoin native addon was not loaded for the current Node.js runtime');
  }

  const missing = missingRequiredExports(raw);
  if (missing.length > 0) {
    throw new Error(`Bitcoin native addon is missing required export(s): ${missing.join(', ')}`);
  }

  const verifier: NativeMerkleVerifier = {
    bitcoinComputeMerkleRoot: (txids: string[]) => raw.bitcoinComputeMerkleRoot(txids),
    bitcoinVerifyMerkleRoot: (txids: string[], expected: string) => raw.bitcoinVerifyMerkleRoot(txids, expected),
    bitcoinVerifyWitnessCommitment: (block: any) => raw.bitcoinVerifyWitnessCommitment(block),
  };

  const bindings: NativeBitcoinBindings = {
    NativeMempoolState: raw.NativeMempoolState,
    NativeMerkleVerifier: verifier,
  };

  setBitcoinNativeBindings(bindings);
} catch (error: unknown) {
  setBitcoinNativeLoadError(error instanceof Error ? error : new Error(String(error)));
}
