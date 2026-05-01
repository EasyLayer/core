#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredNativeTargets, nativeFilename } from './native-platform.mjs';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const nativeDir = path.join(packageRoot, 'dist', 'native');
const missing = [];

for (const target of requiredNativeTargets) {
  const file = path.join(nativeDir, nativeFilename(target));
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) missing.push(file);
}

if (missing.length > 0) {
  console.error('[evm-native] Missing native artifacts:');
  for (const file of missing) console.error(`  - ${path.relative(packageRoot, file)}`);
  process.exit(1);
}

console.log(`[evm-native] Verified ${requiredNativeTargets.length} native artifacts in ${path.relative(packageRoot, nativeDir)}.`);
