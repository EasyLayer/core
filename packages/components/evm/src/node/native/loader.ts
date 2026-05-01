import * as path from 'path';
import type { NativeEvmBindings } from '../../core/native';
import { resolveNativePlatformTarget } from './platform';

function getRequire(): NodeJS.Require | undefined {
  return typeof require === 'function' ? require : undefined;
}

export function loadEvmNativeBindings(): NativeEvmBindings | undefined {
  const target = resolveNativePlatformTarget();
  if (!target) return undefined;

  const req = getRequire();
  if (!req) return undefined;

  const currentDir = typeof __dirname === 'string' ? __dirname : undefined;
  if (!currentDir) return undefined;

  const candidates = [
    path.resolve(currentDir, '../../native', target.filename),
    path.resolve(currentDir, '../../../native', target.filename),
    path.resolve(currentDir, '../../../dist/native', target.filename),
  ];

  for (const candidate of candidates) {
    try {
      return req(candidate) as NativeEvmBindings;
    } catch (error: any) {
      const code = error?.code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_DLOPEN_FAILED') {
        throw error;
      }
    }
  }

  return undefined;
}
