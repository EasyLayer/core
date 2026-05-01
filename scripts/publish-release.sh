#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -euo pipefail

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "❌ NPM_TOKEN is required to publish packages."
  exit 1
fi

mapfile -t PUBLIC_PACKAGES < <(
  node <<'NODE'
  const fs = require('fs');
  const path = require('path');

  const candidates = ['packages/common'];
  const componentsRoot = path.join(process.cwd(), 'packages', 'components');

  if (fs.existsSync(componentsRoot)) {
    for (const entry of fs.readdirSync(componentsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join('packages', 'components', entry.name));
      }
    }
  }

  for (const packagePath of candidates) {
    const packageJsonPath = path.join(process.cwd(), packagePath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    if (packageJson.private === true) {
      continue;
    }

    console.log(`${packageJson.name}\t${packagePath}`);
  }
NODE
)

if [ "${#PUBLIC_PACKAGES[@]}" -eq 0 ]; then
  echo "❌ No public release packages were found."
  exit 1
fi

echo "Release packages discovered:"
printf '  %s\n' "${PUBLIC_PACKAGES[@]}"

for item in "${PUBLIC_PACKAGES[@]}"; do
  IFS=$'\t' read -r package_name package_path <<< "$item"

  echo "Verifying package: ${package_name} (${package_path})"

  if node -e "const pkg = require('./${package_path}/package.json'); process.exit(pkg.scripts && pkg.scripts['check:native-artifacts'] ? 0 : 1);"; then
    yarn workspace "$package_name" check:native-artifacts
  fi

  (
    cd "$package_path"
    npm pack --dry-run --ignore-scripts
  )
done

# All build artifacts were produced by GitHub Actions before this script runs.
# Do not run prepublishOnly here: for native-enabled packages it would clear dist/
# and rebuild only for the publish runner OS.
export NPM_CONFIG_IGNORE_SCRIPTS=true
export npm_config_ignore_scripts=true

# Publish all public monorepo packages from their already-built package folders.
echo "Publishing packages with tag: latest"
./node_modules/.bin/lerna publish from-package --no-private --yes --force-publish

echo "✅ Release has published successfully."
