describe('node native register', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('registers complete required Bitcoin native bindings', () => {
    class FakeNativeMempoolState {}

    jest.doMock('../loader', () => ({
      loadBitcoinNativeBindings: () => ({
        NativeMempoolState: FakeNativeMempoolState,
        bitcoinComputeMerkleRoot: () => '00'.repeat(32),
        bitcoinVerifyMerkleRoot: () => true,
        bitcoinVerifyWitnessCommitment: () => true,
      }),
    }));

    const native = require('../../../core/native');
    require('../register');

    expect(native.requireBitcoinNativeMempoolState()).toBe(FakeNativeMempoolState);
    expect(native.requireBitcoinNativeMerkleVerifier()).toBeDefined();
    expect(native.getBitcoinNativeLoadError()).toBeUndefined();
  });

  it('records a load error when required native exports are missing', () => {
    jest.doMock('../loader', () => ({
      loadBitcoinNativeBindings: () => ({
        NativeMempoolState: class FakeNativeMempoolState {},
        bitcoinComputeMerkleRoot: () => '00'.repeat(32),
      }),
    }));

    const native = require('../../../core/native');
    require('../register');

    expect(native.getBitcoinNativeLoadError()?.message).toMatch(
      /missing required export\(s\): bitcoinVerifyMerkleRoot, bitcoinVerifyWitnessCommitment/
    );
    expect(() => native.requireBitcoinNativeMerkleVerifier()).toThrow(/bitcoinVerifyMerkleRoot/);
  });

  it('records a load error when the native addon is absent', () => {
    jest.doMock('../loader', () => ({
      loadBitcoinNativeBindings: () => undefined,
    }));

    const native = require('../../../core/native');
    require('../register');

    expect(native.getBitcoinNativeLoadError()?.message).toMatch(/native addon was not loaded/);
    expect(() => native.requireBitcoinNativeMempoolState()).toThrow(/native addon was not loaded/);
  });
});
