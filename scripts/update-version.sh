#!/bin/bash

# Stop the script on errors
set -e

# Get version type (e.g., patch, minor or major)
version=$VERSION

# Update package versions (e.g., patch, minor or major)
echo "Setting package versions to: $version"
./node_modules/.bin/lerna version $version --exact --yes --no-git-tag-version --no-push --force-publish=\*

# Get the version number from lerna.json
version_num=$(jq -r '.version' lerna.json)
echo "New Version: $version_num"

# Add changes to Git
if [[ -n $(git status --porcelain) ]]; then
  echo "Committing version changes"
  git config user.name "github-actions"
  git config user.email "github-actions@github.com"
  git add $(find . -name 'package.json' -not -path '*/node_modules/*') yarn.lock lerna.json

  if git diff-index --quiet HEAD --; then
    echo "No changes to commit."
  else
    git commit -m "chore: update version to $version_num"
    # Push to the Git branch
    echo "Pushing version changes to development branch"
    git push origin HEAD
  fi
else
  echo "No changes to commit."
fi