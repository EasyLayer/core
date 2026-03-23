/**
 * rollup.config.mjs — place in packages/components/bitcoin/
 *
 * Build order:
 *   yarn build:cjs                  → dist/
 *   yarn build:esm                  → dist/esm/
 *   yarn build:browser              → rollup reads dist/esm/browser/ → dist/browser/
 *                                     then removes dist/esm/browser/
 *
 * @easylayer/common/* stays external — each subpackage already has
 * its own dist/browser/index.js built by the common rollup step.
 */

import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default defineConfig({
  // Input — already compiled by tsc. No TypeScript plugin needed.
  input: './dist/esm/browser/index.js',

  output: {
    file: './dist/browser/index.js',
    format: 'es',
    sourcemap: false,
    inlineDynamicImports: true,
  },

  external: [
    /^@easylayer\/common/,
    /^@nestjs\//,
    /^rxjs/,
    'reflect-metadata',
    'buffer',
    'electron'
  ],

  plugins: [
    json(),
    commonjs({
      transformMixedEsModules: true,
    }),
    // Resolves npm packages from node_modules using browser conditions.
    nodeResolve({
      browser: true,
      exportConditions: ['browser', 'module', 'default'],
      preferBuiltins: false,
    })
  ],
});
