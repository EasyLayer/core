#!/bin/bash
excluded_dirs=("transport-e2e-tests/")
# excluded_dirs=("transport-e2e-tests/" "node_modules/" "dist/")

for d in */; do
  if [ -f "$d/package.json" ]; then
    skip=false
    for excluded in "${excluded_dirs[@]}"; do
      if [ "$d" == "$excluded" ]; then
        skip=true
        break
      fi
    done
    
    if [ "$skip" = false ]; then
      (cd "$d" && yarn build:esm)
    fi
  fi
done