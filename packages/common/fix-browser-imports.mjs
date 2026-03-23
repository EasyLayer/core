#!/usr/bin/env node
/**
 * Post-build script for @easylayer/common.
 *
 * After tsc compilation, dist/esm/browser/ files contain paths like:
 *   import { X } from "../../../../logger/dist"
 *
 * These should point to the browser dist:
 *   import { X } from "../../../../logger/dist/esm/browser"
 *
 * Run from the packages/common directory after yarn build:
 *   node tools/fix-browser-imports.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Match: ../../../../<pkg>/dist  or  ../../../../<pkg>/dist/index.js etc
// but NOT already-correct paths like ../../../../<pkg>/dist/esm/browser
const NEEDS_FIX = /(['"])((?:\.\.\/)+[^/'"]+\/dist)((?:\/[^'"]*)?)\1/g;

function shouldFix(importPath) {
  return (
    importPath.includes('/dist') &&
    !importPath.includes('/dist/esm/browser') &&
    !importPath.includes('/dist/node') &&
    !importPath.includes('/dist/esm/core') &&
    !importPath.includes('/dist/esm/index')
  );
}

function patchContent(content) {
  return content.replace(NEEDS_FIX, (match, quote, distPath, rest) => {
    if (!shouldFix(distPath + rest)) return match;
    // Replace /dist or /dist/index.js → /dist/esm/browser/index.js
    const browserPath = distPath + '/esm/browser' + (rest && rest !== '/index.js' ? rest : '/index.js');
    return `${quote}${browserPath}${quote}`;
  });
}

function walkAndPatch(dir) {
  let patched = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      patched += walkAndPatch(full);
    } else if (entry.endsWith('.js') || entry.endsWith('.d.ts')) {
      const original = readFileSync(full, 'utf8');
      const fixed = patchContent(original);
      if (fixed !== original) {
        writeFileSync(full, fixed, 'utf8');
        console.log(`  patched: ${full}`);
        patched++;
      }
    }
  }
  return patched;
}

// Find all packages that have dist/esm/browser/
const cwd = process.cwd(); // should be packages/common/
const entries = readdirSync(cwd);

let total = 0;
for (const pkg of entries) {
  const browserDir = join(cwd, pkg, 'dist', 'esm', 'browser');
  try {
    statSync(browserDir);
    console.log(`\n[${pkg}] patching dist/esm/browser/`);
    total += walkAndPatch(browserDir);
  } catch {
    // no browser dist in this package — skip
  }
}

console.log(`\nDone. ${total} file(s) patched.`);
