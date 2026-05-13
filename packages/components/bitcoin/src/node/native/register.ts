import { setBitcoinNativeBindings, setBitcoinNativeLoadError } from '../../core/native';
import type { NativeBitcoinBindings, NativeMerkleVerifier } from '../../core/native';
import { loadBitcoinNativeBindings } from './loader';

try {
  const raw = loadBitcoinNativeBindings() as any;
  if (raw) {
    const bindings: NativeBitcoinBindings = {
      NativeBlocksQueue: raw.NativeBlocksQueue,
      NativeMempoolState: raw.NativeMempoolState,
    };

    // NAPI top-level functions are exported directly on the addon object
    if (raw.bitcoinComputeMerkleRoot && raw.bitcoinVerifyMerkleRoot && raw.bitcoinVerifyWitnessCommitment) {
      const verifier: NativeMerkleVerifier = {
        bitcoinComputeMerkleRoot: (txids: string[]) => raw.bitcoinComputeMerkleRoot(txids),
        bitcoinVerifyMerkleRoot: (txids: string[], expected: string) => raw.bitcoinVerifyMerkleRoot(txids, expected),
        bitcoinVerifyWitnessCommitment: (block: any) => raw.bitcoinVerifyWitnessCommitment(block),
      };
      bindings.NativeMerkleVerifier = verifier;
    }

    setBitcoinNativeBindings(bindings);
  }
} catch (error: unknown) {
  setBitcoinNativeLoadError(error instanceof Error ? error : new Error(String(error)));
}
