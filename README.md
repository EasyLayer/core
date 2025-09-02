<p align="center">
  <b>Core</b> is a tools provide reusable components, utilities, and infrastructure for building EasyLayer apps.
</p>
<br>

<p align="center">
  <a href="https://www.npmjs.com/package/@easylayer/common"><img alt="npm version" src="https://img.shields.io/npm/v/@easylayer/common.svg?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@easylayer/common"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@easylayer/common.svg?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/github/license/easylayer/core?style=flat-square"></a>
</p>

---

<p align="center">
  <a href="https://easylayer.io">Website</a> | <a href="https://easylayer.io/docs">Docs</a> | <a href="https://github.com/easylayer/core/discussions">Discussions</a>
</p>

---

# EasyLayer Core Packages

This repository contains the core packages for EasyLayer applications. It includes common modules and blockchain components:

- <b>@easylayer/common</b>: Shared utilities, CQRS, event sourcing and more.
- <b>@easylayer/bitcoin</b>: Bitcoin blockchain integration and utilities.
- <b>@easylayer/evm</b>: EVM-compatible blockchain integration and utilities.

> EasyLayer provides a suite of ready-to-use, self-hosted solutions for blockchain indexing and real-time crypto processing. Our tools help developers and businesses easily integrate cryptocurrencies into their projects and operations.

## Table of Contents
- [Developer Setup](#developer-setup)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Issue Reporting](#issue-reporting)
- [License](#license)

## Developer Setup

> <b>Node.js version:</b> 17 or higher is required. We recommend using the latest LTS (currently 22+).<br>
> <b>Yarn version:</b> 4.5+ is required (Yarn Berry).  
> Yarn is included in the repository under <code>.yarn/releases/</code>, so you do not need to install it globally.  
> You can run all commands using <code>yarn</code> if you have Yarn 4+ or Corepack enabled, or use <code>node .yarn/releases/yarn-4.5.0.cjs &lt;command&gt;</code> directly.

1. **Clone the repository:**
```bash
git clone https://github.com/easylayer/core.git
cd core
```

2. **Install dependencies:**
```bash
yarn install
```

3. **Build all packages:**
```bash
yarn build
```

4. **Run unit tests:**
```bash
yarn test:unit
```

5. **Lint and format code:**
```bash
yarn lint
# or
yarn lint:fix
```

## Documentation

Developer documentation is generated using [TypeDoc](https://typedoc.org/):
```bash
yarn docs:development:generate
```
The generated docs will be available in the `typedoc/` directory.

## Contributing

We welcome contributions! To get started:
- Fork this repository and create a new branch for your feature or bugfix.
- Make your changes and ensure all tests and lints pass locally.
- Submit a pull request (PR) to the `development` branch.
- - All PRs must use the provided pull request template.
- - Branch names and commit messages must follow the [Conventional Changelog](https://www.conventionalcommits.org/) style. Allowed types: `feat`, `fix`, `infra`, `refactor`, `chore`, `BREAKING` (see `.czrc` for details). Please use descriptive messages for each commit.
- - All PRs are automatically checked by our GitHub Actions workflow (build, lint, unit tests).

## Issue Reporting

If you encounter a bug or have a feature request related to the `core` repository, please [open an issue](https://github.com/easylayer/core/issues/new/choose) and provide as much detail as possible. For issues related to other EasyLayer projects, please use the appropriate repository.

## License

This project is licensed under the [License](./LICENSE).