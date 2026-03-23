/**
 * rollup.config.mjs — place in the root of packages/common/
 *
 * Build order:
 *   yarn build:cjs                  → dist/
 *   yarn build:esm                  → dist/esm/
 *   node fix-browser-imports.mjs    → patch relative paths in dist/esm/browser/
 *   yarn build:browser              → rollup reads dist/esm/browser/ → dist/browser/
 *
 * Each subpackage gets a self-contained dist/browser/index.js:
 *   - all relative imports (including cross-subpackage via ../../../../) are bundled in
 *   - npm packages stay external (they will be bundled inside bitcoin-crawler)
 *
 * Subpackages are discovered automatically — any folder with a package.json
 * AND a dist/esm/browser/index.js is included.
 */

import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { readdirSync, existsSync, statSync } from 'fs';

// Auto-discover subpackages: any subfolder that has both
// package.json and dist/esm/browser/index.js (built by tsc)
const subpackages = readdirSync('.').filter((name) => {
  if (!statSync(name).isDirectory()) return false;
  if (!existsSync(`./${name}/package.json`)) return false;
  if (!existsSync(`./${name}/dist/esm/browser/index.js`)) return false;
  return true;
});

console.log(`Found browser subpackages: ${subpackages.join(', ')}`);

const external = [
  /^@nestjs\//,      // NestJS — will be bundled at bitcoin-crawler level
  /^rxjs/,           // pulled in by @nestjs/common
  'reflect-metadata', // must be a singleton, bundled once at the top level
  /^typeorm/,        // eventstore — dynamic import, aliased at bitcoin-crawler level
  'async-mutex',     // eventstore
  'buffer',          // available globally in browser via polyfill
  'electron',
  '@sqlite.org/sqlite-wasm'
];

export default subpackages.map((pkg) =>
  defineConfig({
    // Input — already compiled by tsc and patched by fix-browser-imports.mjs.
    // We read JS directly so no TypeScript plugin is needed here.
    input: `./${pkg}/dist/esm/browser/index.js`,

    output: {
      file: `./${pkg}/dist/browser/index.js`,
      format: 'es',
      sourcemap: false,
      inlineDynamicImports: true,
    },

    external,

    // Suppress "this has been rewritten to undefined" warnings —
    // this is expected for TypeScript decorator helpers (__decorate)
    // in ESM output, it does not affect runtime behavior.
    onwarn(warning, warn) {
      if (warning.code === 'THIS_IS_UNDEFINED') return;
      warn(warning);
    },

    plugins: [
      commonjs(),
      // Resolves npm packages from node_modules using browser conditions.
      // preferBuiltins: false — let shims handle Node built-ins at bitcoin-crawler level.
      nodeResolve({
        browser: true,
        exportConditions: ['browser', 'module', 'default'],
        preferBuiltins: false,
      }),
    ],
  })
);
