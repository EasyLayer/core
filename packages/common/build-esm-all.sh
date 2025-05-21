#!/bin/bash
for d in */; do
  if [ -f "$d/package.json" ]; then
    (cd "$d" && yarn build:esm)
  fi
done