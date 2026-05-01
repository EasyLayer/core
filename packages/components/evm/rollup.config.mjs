/**
 * Browser build for @easylayer/evm.
 * Build order:
 *   yarn build:cjs     -> dist/
 *   yarn build:esm     -> dist/esm/
 *   yarn build:browser -> dist/browser/index.js from dist/esm/browser/index.js
 *
 * The browser entry intentionally excludes Node-only websocket/socket concerns.
 * EVM providers are JSON-RPC compatible and can run over browser fetch/HTTP providers.
 */
import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default defineConfig({
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
  ],
  onwarn(warning, warn) {
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    warn(warning);
  },
  plugins: [
    json(),
    commonjs({ transformMixedEsModules: true }),
    nodeResolve({
      browser: true,
      exportConditions: ['browser', 'module', 'default'],
      preferBuiltins: false,
    }),
  ],
});
