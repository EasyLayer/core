#!/usr/bin/env node
import os from 'node:os';
import process from 'node:process';

export const requiredNativeTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'win32-x64-msvc',
];

const runtimeTargetMap = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'linux-x64-gnu': { platform: 'linux', arch: 'x64', libc: 'gnu' },
  'linux-arm64-gnu': { platform: 'linux', arch: 'arm64', libc: 'gnu' },
  'win32-x64-msvc': { platform: 'win32', arch: 'x64' },
};

function detectLibc() {
  if (process.platform !== 'linux') return undefined;
  return process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'gnu';
}

export function currentRuntimeTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'x64') return `linux-x64-${detectLibc() ?? 'gnu'}`;
  if (platform === 'linux' && arch === 'arm64') return `linux-arm64-${detectLibc() ?? 'gnu'}`;
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc';

  throw new Error(`Unsupported native target: ${platform}/${arch} (${os.type()})`);
}

export function resolveNativeTarget() {
  const override = process.env.NATIVE_TARGET;
  if (override) {
    if (!requiredNativeTargets.includes(override)) {
      throw new Error(`Unsupported NATIVE_TARGET: ${override}`);
    }
    return override;
  }

  return currentRuntimeTarget();
}

export function assertNativeTargetMatchesRuntime(target = resolveNativeTarget()) {
  if (process.env.CARGO_BUILD_TARGET) {
    return;
  }

  const expected = runtimeTargetMap[target];
  if (!expected) {
    throw new Error(`Unsupported native target: ${target}`);
  }

  const runtime = currentRuntimeTarget();

  if (runtime !== target) {
    throw new Error(
      [
        `[bitcoin-native] NATIVE_TARGET=${target} does not match this runner (${runtime}).`,
        'Build native artifacts on the matching GitHub Actions runner, or set CARGO_BUILD_TARGET explicitly for cross-compilation.',
      ].join(' ')
    );
  }
}

export function nativeFilename(target = resolveNativeTarget()) {
  return `bitcoin-native-${target}.node`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = resolveNativeTarget();
  console.log(JSON.stringify({ target, filename: nativeFilename(target) }, null, 2));
  process.exit(0);
}
