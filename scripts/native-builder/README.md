# Native artifact builder

This folder contains the local builder used to create platform-specific Rust/N-API artifacts for packages in the core monorepo.

## Commands

From the core repository root:

```bash
yarn native:build --package @easylayer/bitcoin --target darwin-arm64
yarn native:build --package @easylayer/bitcoin --target linux-x64-gnu
yarn native:build --package @easylayer/bitcoin --target linux-arm64-gnu
yarn native:build --package @easylayer/bitcoin --targets darwin-arm64,linux-x64-gnu
yarn native:build --package @easylayer/bitcoin --all-linux
```

Linux targets are built inside Docker. The builder image is built per native target and Docker platform, for example `easylayer-core-native-builder:linux-x64-gnu-node20-rust-stable` for `linux/amd64`. macOS targets are built locally and must match the current runner unless explicit Rust cross-compilation is configured with `CARGO_BUILD_TARGET`.

## Docker builder image behavior

The builder does not pull `easylayer-core-native-builder` from a registry. It builds the image locally before `docker run` unless `--skip-docker-build` is passed.

For cross-platform correctness on macOS, the image tag includes the target and the build uses `docker buildx build --load --platform ...`:

```text
easylayer-core-native-builder:linux-x64-gnu-node20-rust-stable  -> linux/amd64
easylayer-core-native-builder:linux-arm64-gnu-node20-rust-stable -> linux/arm64
```

This avoids a Mac ARM host accidentally building only a `linux/arm64` image and then failing when `docker run --platform linux/amd64` tries to use `linux-x64-gnu`.

Use `--skip-docker-build` only when the exact target-specific local image already exists.

## Supported package targets

Currently supported package:

```text
@easylayer/bitcoin
```

Currently supported targets:

```text
darwin-arm64
darwin-x64
linux-x64-gnu
linux-arm64-gnu
win32-x64-msvc
```

The local Docker builder supports Linux GNU targets. Windows artifacts should be built on a Windows runner. macOS artifacts should be built on a matching macOS runner unless explicit cross-compilation is configured.
