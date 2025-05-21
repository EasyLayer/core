import { defineConfig } from 'rollup';
import baseConfig from '../../../rollup.config.mjs';

export default defineConfig({
  ...baseConfig,
  external: id =>
    id === 'typeorm' || id.startsWith('typeorm/') ||
    /* … */
    false
});