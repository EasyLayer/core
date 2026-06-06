#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assertNativeTargetMatchesRuntime, nativeFilename, resolveNativeTarget } from './native-platform.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const crateDir = path.join(packageRoot, 'native', 'bitcoin-native');
const target = resolveNativeTarget();
const outDir = path.join(packageRoot, 'dist', 'native');
const outFile = path.join(outDir, nativeFilename(target));
const required = process.env.NATIVE_BUILD_REQUIRED === '1';
const require = createRequire(import.meta.url);

const REQUIRED_NATIVE_MEMPOOL_METHODS = [
  ['applySnapshot', ['applySnapshot']],
  ['mergeSnapshot', ['mergeSnapshot', 'merge_snapshot']],
  ['removeTxids', ['removeTxids', 'remove_txids']],
  ['providers', ['providers']],
  ['pendingTxids', ['pendingTxids']],
  ['recordLoaded', ['recordLoaded']],
  ['txIds', ['txIds']],
  ['loadedTransactions', ['loadedTransactions']],
  ['metadata', ['metadata']],
  ['hasTransaction', ['hasTransaction']],
  ['isTransactionLoaded', ['isTransactionLoaded']],
  ['getTransactionMetadata', ['getTransactionMetadata']],
  ['getFullTransaction', ['getFullTransaction']],
  ['getStats', ['getStats']],
  ['getMemoryUsage', ['getMemoryUsage']],
  ['exportSnapshot', ['exportSnapshot']],
  ['importSnapshot', ['importSnapshot']],
  ['dispose', ['dispose']],
];


function artifactCandidatesForTarget(nativeTarget, releaseDir) {
  if (nativeTarget.startsWith('linux-')) {
    return [
      path.join(releaseDir, 'libeasylayer_bitcoin_native.so'),
      path.join(releaseDir, 'easylayer_bitcoin_native.node'),
    ];
  }

  if (nativeTarget.startsWith('darwin-')) {
    return [
      path.join(releaseDir, 'libeasylayer_bitcoin_native.dylib'),
      path.join(releaseDir, 'easylayer_bitcoin_native.node'),
    ];
  }

  if (nativeTarget.startsWith('win32-')) {
    return [
      path.join(releaseDir, 'easylayer_bitcoin_native.dll'),
      path.join(releaseDir, 'easylayer_bitcoin_native.node'),
    ];
  }

  throw new Error(`[bitcoin-native] unsupported artifact candidate target: ${nativeTarget}`);
}

function resolveCargoReleaseDir() {
  const cargoTarget = process.env.CARGO_BUILD_TARGET;
  const cargoTargetDir = process.env.CARGO_TARGET_DIR;

  if (cargoTargetDir) {
    return cargoTarget
      ? path.join(cargoTargetDir, cargoTarget, 'release')
      : path.join(cargoTargetDir, 'release');
  }

  return cargoTarget
    ? path.join(crateDir, 'target', cargoTarget, 'release')
    : path.join(crateDir, 'target', 'release');
}

function assertRegularFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`[bitcoin-native] artifact candidate is not a regular file: ${file}`);
  }
}

function nativeMethodNames(native) {
  const names = new Set();
  let cursor = native;
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name !== 'constructor' && typeof native[name] === 'function') names.add(name);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return [...names].sort();
}

function verifyBuiltNativeArtifact(file) {
  const raw = require(file);
  const missing = [];

  if (!raw.NativeMempoolState) missing.push('NativeMempoolState');
  if (typeof raw.bitcoinComputeMerkleRoot !== 'function') missing.push('bitcoinComputeMerkleRoot');
  if (typeof raw.bitcoinVerifyMerkleRoot !== 'function') missing.push('bitcoinVerifyMerkleRoot');
  if (typeof raw.bitcoinVerifyWitnessCommitment !== 'function') missing.push('bitcoinVerifyWitnessCommitment');

  let availableMempoolMethods = [];
  if (raw.NativeMempoolState) {
    const native = new raw.NativeMempoolState();
    availableMempoolMethods = nativeMethodNames(native);
    const missingMethods = REQUIRED_NATIVE_MEMPOOL_METHODS
      .filter(([, aliases]) => !aliases.some(alias => typeof native[alias] === 'function'))
      .map(([canonical]) => canonical);
    if (missingMethods.length > 0) {
      missing.push(
        `NativeMempoolState method(s): ${missingMethods.join(', ')} ` +
        `(available: ${availableMempoolMethods.length ? availableMempoolMethods.join(', ') : '<none>'})`
      );
    }
  }

  if (availableMempoolMethods.length > 0) {
    console.log(`[bitcoin-native] verified NativeMempoolState methods: ${availableMempoolMethods.join(', ')}`);
  }

  if (missing.length > 0) {
    throw new Error(`[bitcoin-native] built artifact failed native contract check: ${missing.join('; ')}`);
  }
}

assertNativeTargetMatchesRuntime(target);

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

if (!commandExists('cargo')) {
  const message = '[bitcoin-native] cargo is not installed; skipping native build.';
  if (required) throw new Error(message);
  console.warn(message);
  process.exit(0);
}

const cargoTarget = process.env.CARGO_BUILD_TARGET;
const cargoArgs = ['build', '--release'];
if (cargoTarget) cargoArgs.push('--target', cargoTarget);

const result = spawnSync('cargo', cargoArgs, {
  cwd: crateDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  throw new Error(`[bitcoin-native] cargo build failed with status ${result.status}`);
}

const releaseDir = resolveCargoReleaseDir();
const candidates = artifactCandidatesForTarget(target, releaseDir);

const built = candidates.find(candidate => fs.existsSync(candidate));
if (!built) {
  throw new Error(
    [
      `[bitcoin-native] cannot find built native library for ${target} in ${releaseDir}.`,
      `Checked candidates: ${candidates.join(', ')}`,
    ].join(' ')
  );
}

assertRegularFile(built);
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outFile, { force: true });
fs.copyFileSync(built, outFile);
verifyBuiltNativeArtifact(outFile);
console.log(`[bitcoin-native] copied ${built} -> ${outFile}`);
