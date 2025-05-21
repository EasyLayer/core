#!/bin/bash

# Stop the script on errors
set -e

# Get version type (e.g., patch, minor or major)
version=$VERSION

git config user.name "github-actions"
git config user.email "github-actions@github.com"

# ────────────────────────────────────────────────────────────────────────────────
# generate_changelog
#
# 1. Fetch all tags and update refs.
# 2. Determine the latest semantic version tag (vX.Y.Z).
# 3a. If no tag is found, generate the full changelog (-r 0).
# 3b. Otherwise, generate only the next release section (-r 1).
# ────────────────────────────────────────────────────────────────────────────────
generate_changelog() {
  # Fetch the latest commits and tags from main, then merge into current branch
  git fetch origin master --tags
  git merge --no-ff origin/master --no-edit

  # Retrieve the latest semantic version tag
  local latest_tag
  latest_tag=$(git tag --list --sort=-version:refname | head -n1)

  if [ -z "$latest_tag" ]; then
    echo "📝  No tags found. Generating full CHANGELOG…"
    node_modules/.bin/conventional-changelog -p angular -i CHANGELOG.md -s -r 0
  else
    echo "📝  Latest tag is $latest_tag — generating only the next release…"
    node_modules/.bin/conventional-changelog -p angular -i CHANGELOG.md -s -r 1
  fi
}

# ────────────────────────────────────────────────────────────────────────────────


# Update package versions (e.g., patch, minor or major)
echo "Setting package versions to: $version"
./node_modules/.bin/lerna version $version --exact --yes --no-git-tag-version --no-push --force-publish=\*

# Get the version number from lerna.json
version_num=$(jq -r '.version' lerna.json)
echo "✨  New version is v$version_num"

# Generate or update CHANGELOG.md in one call
echo "📝  Generating CHANGELOG.md"
generate_changelog

# Commit all changes in a single commit (version bump, CHANGELOG, docs)
echo "🚀  Committing all changes"
git add \
  $(find . -maxdepth 2 -type f \( -name 'package.json' -o -name 'lerna.json' \)) \
  yarn.lock \
  CHANGELOG.md

# Only commit if there are staged changes
if ! git diff --cached --quiet; then
  git commit -m "release v$version_num"
  git push origin HEAD
else
  echo "⚠️  No changes to commit"
fi

echo "✅  Prepering branch for v$version_num completed"