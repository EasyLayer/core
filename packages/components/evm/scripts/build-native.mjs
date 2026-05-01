#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { assertNativeTargetMatchesRuntime, nativeFilename, resolveNativeTarget } from './native-platform.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const crateDir = path.join(packageRoot, 'native', 'evm-native');
const target = resolveNativeTarget();
const outDir = path.join(packageRoot, 'dist', 'native');
const outFile = path.join(outDir, nativeFilename(target));
const required = process.env.NATIVE_BUILD_REQUIRED === '1';

assertNativeTargetMatchesRuntime(target);

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

if (!commandExists('cargo')) {
  const message = '[evm-native] cargo is not installed; skipping native build.';
  if (required) throw new Error(message);
  console.warn(message);
  process.exit(0);
}

const cargoTarget = process.env.CARGO_BUILD_TARGET;
const cargoArgs = ['build', '--release'];
if (cargoTarget) cargoArgs.push('--target', cargoTarget);

const result = spawnSync('cargo', cargoArgs, { cwd: crateDir, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) throw new Error(`[evm-native] cargo build failed with status ${result.status}`);

const releaseDir = cargoTarget ? path.join(crateDir, 'target', cargoTarget, 'release') : path.join(crateDir, 'target', 'release');
const candidates = [
  path.join(releaseDir, 'easylayer_evm_native.dll'),
  path.join(releaseDir, 'libeasylayer_evm_native.dylib'),
  path.join(releaseDir, 'libeasylayer_evm_native.so'),
  path.join(releaseDir, 'easylayer_evm_native.node'),
];

const built = candidates.find(candidate => fs.existsSync(candidate));
if (!built) throw new Error(`[evm-native] cannot find built native library in ${releaseDir}`);

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(built, outFile);
console.log(`[evm-native] copied ${built} -> ${outFile}`);
