#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Publish packages with default "latest" tag
echo "Publishing packages with tag: latest"
./node_modules/.bin/lerna publish from-package --no-private --yes --force-publish
if [ $? -ne 0 ]; then
    echo "Lerna publish failed!"
    exit 1
fi

echo "✅  Release has published successfully."
