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
 *
 * 'buffer' is intentionally NOT external: bitcoinjs-lib / typeforce use bare
 * `Buffer` global (no import). We bundle the npm `buffer` shim and expose it
 * via globalThis.Buffer in the intro so every CJS wrapper can find it.
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
    // ESM rule: `import` must precede all statements → only the Buffer import goes here.
    banner: `import { Buffer as __Buffer__ } from 'buffer';`,
    // intro runs after all imports, before the rest of the module body.
    // Sets globalThis.Buffer so every CJS wrapper (typeforce, bitcoinjs-lib, etc.)
    // that uses bare `Buffer` global can find it.
    intro: `
if (!globalThis.Buffer) globalThis.Buffer = __Buffer__;
    `.trim(),
  },

  external: [
    /^@easylayer\/common/,
    /^@nestjs\//,
    /^rxjs/,
    'reflect-metadata',
    // 'buffer' removed — must be bundled so globalThis.Buffer is self-contained
    'electron',
  ],

  onwarn(warning, warn) {
    // Expected for TypeScript decorator helpers in ESM output
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    // Expected for bitcoinjs-lib internal structure
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    // bip39 is CJS used via `import * as bip39` — named exports aren't statically
    // detectable by rollup but exist on the default export at runtime.
    if (warning.code === 'MISSING_EXPORT' && warning.exporter?.includes('bip39')) return;
    warn(warning);
  },

  plugins: [
    json(),
    commonjs({
      transformMixedEsModules: true,
    }),
    // Resolves npm packages from node_modules using browser conditions.
    // preferBuiltins: false → 'buffer' resolves to the npm shim, not Node built-in.
    nodeResolve({
      browser: true,
      exportConditions: ['browser', 'module', 'default'],
      preferBuiltins: false,
    }),
  ],
});
