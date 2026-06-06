#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const builderDir = path.join(repoRoot, 'scripts', 'native-builder');

const supportedTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'win32-x64-msvc',
];

const linuxDockerPlatformByTarget = {
  'linux-x64-gnu': 'linux/amd64',
  'linux-arm64-gnu': 'linux/arm64',
};

const packages = {
  '@easylayer/bitcoin': {
    packageDir: 'packages/components/bitcoin',
    nativeBuildScript: 'scripts/build-native.mjs',
    artifactDir: 'dist/native',
    artifactName: target => `bitcoin-native-${target}.node`,
    nativeCrateDir: 'native/bitcoin-native',
  },
};

function usage() {
  return `Usage:
  yarn native:build --package @easylayer/bitcoin --target linux-x64-gnu
  yarn native:build --package @easylayer/bitcoin --targets darwin-arm64,linux-x64-gnu
  yarn native:build --package @easylayer/bitcoin --all-linux

Options:
  --package <name>       Package to build. Currently supported: ${Object.keys(packages).join(', ')}
  --target <target>      Native target to build: ${supportedTargets.join(', ')}
  --targets <list>       Comma-separated target list.
  --all-linux            Build linux-x64-gnu and linux-arm64-gnu with Docker.
  --docker               Force Docker for supported Linux targets.
  --local                Force local build. Target must match the current runner unless the package script supports cross-compilation.
  --skip-docker-build    Reuse an existing native-builder Docker image.
  --list-packages        Print supported packages.
  --list-targets         Print supported targets.
  --dry-run              Print commands without running them.
`;
}

function parseArgs(argv) {
  const args = {
    packageName: undefined,
    targets: [],
    forceDocker: false,
    forceLocal: false,
    skipDockerBuild: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--list-packages') {
      console.log(Object.keys(packages).join('\n'));
      process.exit(0);
    }
    if (arg === '--list-targets') {
      console.log(supportedTargets.join('\n'));
      process.exit(0);
    }
    if (arg === '--package') {
      args.packageName = argv[++i];
      continue;
    }
    if (arg === '--target') {
      args.targets.push(argv[++i]);
      continue;
    }
    if (arg === '--targets') {
      args.targets.push(...String(argv[++i] ?? '').split(',').map(item => item.trim()).filter(Boolean));
      continue;
    }
    if (arg === '--all-linux') {
      args.targets.push('linux-x64-gnu', 'linux-arm64-gnu');
      continue;
    }
    if (arg === '--docker') {
      args.forceDocker = true;
      continue;
    }
    if (arg === '--local') {
      args.forceLocal = true;
      continue;
    }
    if (arg === '--skip-docker-build') {
      args.skipDockerBuild = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (!args.packageName) {
    throw new Error(`Missing --package.\n\n${usage()}`);
  }
  if (!packages[args.packageName]) {
    throw new Error(`Unsupported package: ${args.packageName}. Supported packages: ${Object.keys(packages).join(', ')}`);
  }
  if (args.forceDocker && args.forceLocal) {
    throw new Error('Use either --docker or --local, not both.');
  }

  args.targets = [...new Set(args.targets)];
  if (args.targets.length === 0) {
    throw new Error(`Missing --target/--targets/--all-linux.\n\n${usage()}`);
  }
  for (const target of args.targets) {
    if (!supportedTargets.includes(target)) {
      throw new Error(`Unsupported target: ${target}. Supported targets: ${supportedTargets.join(', ')}`);
    }
  }

  return args;
}

function currentRuntimeTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64-gnu';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc';
  return `${platform}-${arch}`;
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  console.log(`[native-builder] ${printable}`);
  if (options.dryRun) return;

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`[native-builder] command failed with status ${result.status}: ${printable}`);
  }
}

function dockerImageTagForTarget(target) {
  return `easylayer-core-native-builder:${target}-node20-rust-stable`;
}

function cargoTargetDirFor(pkg, target) {
  if (!pkg.nativeCrateDir) return undefined;
  return `/repo/${pkg.packageDir}/${pkg.nativeCrateDir}/target/native-${target}`;
}

function imageExists(image, dryRun) {
  if (dryRun) return true;
  const result = spawnSync('docker', ['image', 'inspect', image], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function buildDockerImage({ target, platform, dryRun, skipDockerBuild }) {
  const image = dockerImageTagForTarget(target);
  if (skipDockerBuild) {
    if (!imageExists(image, dryRun)) {
      throw new Error(
        [
          `Docker image ${image} does not exist locally.`,
          'Remove --skip-docker-build or build the image first.',
        ].join(' ')
      );
    }
    return image;
  }

  run('docker', [
    'buildx',
    'build',
    '--load',
    '--platform', platform,
    '-f', path.join(builderDir, 'Dockerfile.linux-gnu'),
    '-t', image,
    builderDir,
  ], { dryRun });

  if (!imageExists(image, dryRun)) {
    throw new Error(
      [
        `Docker image ${image} was not loaded after build.`,
        'Docker Desktop/buildx may require --load support. Check docker buildx configuration.',
      ].join(' ')
    );
  }

  return image;
}

function buildWithDocker(pkg, packageName, target, options) {
  const platform = linuxDockerPlatformByTarget[target];
  if (!platform) {
    throw new Error(`Docker builder currently supports Linux GNU targets only. Target ${target} must be built on a matching runner.`);
  }

  const image = buildDockerImage({ ...options, target, platform });
  const packageDir = `/repo/${pkg.packageDir}`;
  const cargoTargetDir = cargoTargetDirFor(pkg, target);
  const command = [
    `cd ${packageDir}`,
    `NATIVE_TARGET=${target} NATIVE_BUILD_REQUIRED=1${cargoTargetDir ? ` CARGO_TARGET_DIR=${cargoTargetDir}` : ''} node ./${pkg.nativeBuildScript}`,
  ].join(' && ');

  run('docker', [
    'run',
    '--rm',
    '--platform', platform,
    '-v', `${repoRoot}:/repo`,
    '-w', '/repo',
    '-e', `NATIVE_TARGET=${target}`,
    '-e', 'NATIVE_BUILD_REQUIRED=1',
    ...(cargoTargetDir ? ['-e', `CARGO_TARGET_DIR=${cargoTargetDir}`] : []),
    image,
    'bash',
    '-lc',
    command,
  ], options);

  printArtifact(pkg, packageName, target);
}

function buildLocal(pkg, packageName, target, options) {
  const runtime = currentRuntimeTarget();
  if (runtime !== target && !process.env.CARGO_BUILD_TARGET) {
    throw new Error(
      [
        `Cannot build ${target} locally on ${runtime} without CARGO_BUILD_TARGET.`,
        'Use a matching runner, a Linux Docker target, or configure explicit Rust cross-compilation.',
      ].join(' ')
    );
  }

  const packageRoot = path.join(repoRoot, pkg.packageDir);
  run('node', [`./${pkg.nativeBuildScript}`], {
    ...options,
    cwd: packageRoot,
    env: {
      ...process.env,
      NATIVE_TARGET: target,
      NATIVE_BUILD_REQUIRED: '1',
      ...(pkg.nativeCrateDir ? {
        CARGO_TARGET_DIR: path.join(packageRoot, pkg.nativeCrateDir, 'target', `native-${target}`),
      } : {}),
    },
  });

  printArtifact(pkg, packageName, target);
}

function printArtifact(pkg, packageName, target) {
  const artifact = path.join(pkg.packageDir, pkg.artifactDir, pkg.artifactName(target));
  console.log(`[native-builder] ${packageName} ${target} artifact: ${artifact}`);
}

function buildTarget(pkg, packageName, target, options) {
  const useDocker = !options.forceLocal && (options.forceDocker || Boolean(linuxDockerPlatformByTarget[target]));

  if (useDocker) {
    buildWithDocker(pkg, packageName, target, options);
    return;
  }

  buildLocal(pkg, packageName, target, options);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = packages[args.packageName];

  console.log(`[native-builder] package=${args.packageName}`);
  console.log(`[native-builder] targets=${args.targets.join(', ')}`);
  console.log(`[native-builder] host=${os.platform()}/${os.arch()} runtimeTarget=${currentRuntimeTarget()}`);

  for (const target of args.targets) {
    buildTarget(pkg, args.packageName, target, args);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
