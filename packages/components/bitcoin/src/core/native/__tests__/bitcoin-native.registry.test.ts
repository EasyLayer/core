import {
  getBitcoinNativeLoadError,
  isBitcoinNativeAvailable,
  isBitcoinNativeMempoolStateAvailable,
  isBitcoinNativeMerkleVerifierAvailable,
  requireBitcoinNativeMempoolState,
  requireBitcoinNativeMerkleVerifier,
  setBitcoinNativeBindings,
  setBitcoinNativeLoadError,
} from '../bitcoin-native.registry';

describe('bitcoin native registry capability checks', () => {
  afterEach(() => {
    setBitcoinNativeBindings(undefined);
  });

  it('does not require any native block queue for native merkle or mempool capability', () => {
    setBitcoinNativeBindings({
      NativeMempoolState: class FakeNativeMempoolState {} as any,
      NativeMerkleVerifier: {
        bitcoinComputeMerkleRoot: () => '00'.repeat(32),
        bitcoinVerifyMerkleRoot: () => true,
        bitcoinVerifyWitnessCommitment: () => true,
      },
    });

    expect(isBitcoinNativeAvailable()).toBe(true);
    expect(isBitcoinNativeMempoolStateAvailable()).toBe(true);
    expect(isBitcoinNativeMerkleVerifierAvailable()).toBe(true);
    expect(requireBitcoinNativeMempoolState()).toBeDefined();
    expect(requireBitcoinNativeMerkleVerifier()).toBeDefined();
  });

  it('tracks a native load error without pretending that any component is available', () => {
    const error = new Error('native addon failed to load');
    setBitcoinNativeLoadError(error);

    expect(getBitcoinNativeLoadError()).toBe(error);
    expect(isBitcoinNativeAvailable()).toBe(false);
    expect(isBitcoinNativeMempoolStateAvailable()).toBe(false);
    expect(isBitcoinNativeMerkleVerifierAvailable()).toBe(false);
    expect(() => requireBitcoinNativeMempoolState()).toThrow(/native addon failed to load/);
    expect(() => requireBitcoinNativeMerkleVerifier()).toThrow(/native addon failed to load/);
  });

  it('requires component-specific native bindings instead of allowing partial fallback', () => {
    setBitcoinNativeBindings({
      NativeMempoolState: class FakeNativeMempoolState {} as any,
    });

    expect(requireBitcoinNativeMempoolState()).toBeDefined();
    expect(() => requireBitcoinNativeMerkleVerifier()).toThrow(/NativeMerkleVerifier requires the Bitcoin Rust native addon/);
  });
});
