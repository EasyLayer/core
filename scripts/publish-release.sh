#!/bin/bash

# Stop the script on errors
set -e

git config user.name "github-actions"
git config user.email "github-actions@github.com"

# Publish packages with default "latest" tag
echo "Publishing packages with tag: latest"
./node_modules/.bin/lerna publish from-package --no-private --yes --force-publish
if [ $? -ne 0 ]; then
    echo "Lerna publish failed!"
    exit 1
fi

# Get the last created tag for the current commit
tagName=$(git describe --tags --abbrev=0 --match "v*" $(git rev-parse HEAD))

# Ensure tagName is not empty
if [ -z "$tagName" ]; then
    echo "No tag found!"
    exit 1
fi

# Save the tag name to a file for GitHub Actions
echo "$tagName" > tag_name.txt
