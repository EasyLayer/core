import { defineConfig } from 'rollup';
import baseConfig from '../../../rollup.config.mjs';

export default defineConfig({
  ...baseConfig,
  external: id =>
    id === 'socket.io' || id.startsWith('socket.io/') ||
    false
});