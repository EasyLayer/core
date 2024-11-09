#!/bin/bash

# Stop the script on errors
set -e

# Publish packages with default "latest" tag
echo "Publishing packages with tag: latest"
./node_modules/.bin/lerna publish from-package --no-private --yes --force-publish
if [ $? -ne 0 ]; then
    echo "Lerna publish failed!"
    exit 1
fi

echo "Packages published successfully."
