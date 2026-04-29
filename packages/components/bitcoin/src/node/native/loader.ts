import * as path from 'path';
import type { NativeBitcoinBindings } from '../../core/native';
import { resolveNativePlatformTarget } from './platform';

function getRequire(): NodeJS.Require | undefined {
  // Works in CJS. In ESM/browser bundles require is absent; native loading is skipped.
  return typeof require === 'function' ? require : undefined;
}

export function loadBitcoinNativeBindings(): NativeBitcoinBindings | undefined {
  const target = resolveNativePlatformTarget();
  if (!target) return undefined;

  const req = getRequire();
  if (!req) return undefined;

  const currentDir = typeof __dirname === 'string' ? __dirname : undefined;
  if (!currentDir) return undefined;

  const candidates = [
    // Runtime after CJS build: dist/node/native/loader.js -> dist/native/*.node
    path.resolve(currentDir, '../../native', target.filename),
    // Runtime after ESM build: dist/esm/node/native/loader.js -> dist/native/*.node
    path.resolve(currentDir, '../../../native', target.filename),
    // Runtime directly from src in ts-node/jest if native artifact was copied manually.
    path.resolve(currentDir, '../../../dist/native', target.filename),
  ];

  for (const candidate of candidates) {
    try {
      return req(candidate) as NativeBitcoinBindings;
    } catch (error: any) {
      const code = error?.code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_DLOPEN_FAILED') {
        throw error;
      }
    }
  }

  return undefined;
}
