export interface NativePlatformTarget {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  libc?: 'gnu' | 'musl';
  packageTarget: string;
  filename: string;
}

function detectLibc(): 'gnu' | 'musl' | undefined {
  if (process.platform !== 'linux') return undefined;

  const processReport = (
    process as unknown as {
      report?: {
        getReport?: () => { header?: { glibcVersionRuntime?: string } };
      };
    }
  ).report;
  const report = typeof processReport?.getReport === 'function' ? processReport.getReport() : undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  if (glibc) return 'gnu';

  return 'gnu';
}

export function resolveNativePlatformTarget(): NativePlatformTarget | undefined {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin' && arch === 'arm64') {
    return { platform, arch, packageTarget: 'darwin-arm64', filename: 'evm-native-darwin-arm64.node' };
  }

  if (platform === 'darwin' && arch === 'x64') {
    return { platform, arch, packageTarget: 'darwin-x64', filename: 'evm-native-darwin-x64.node' };
  }

  if (platform === 'linux' && arch === 'x64') {
    const libc = detectLibc();
    return {
      platform,
      arch,
      libc,
      packageTarget: `linux-x64-${libc ?? 'gnu'}`,
      filename: `evm-native-linux-x64-${libc ?? 'gnu'}.node`,
    };
  }

  if (platform === 'linux' && arch === 'arm64') {
    const libc = detectLibc();
    return {
      platform,
      arch,
      libc,
      packageTarget: `linux-arm64-${libc ?? 'gnu'}`,
      filename: `evm-native-linux-arm64-${libc ?? 'gnu'}.node`,
    };
  }

  if (platform === 'win32' && arch === 'x64') {
    return { platform, arch, packageTarget: 'win32-x64-msvc', filename: 'evm-native-win32-x64-msvc.node' };
  }

  return undefined;
}
