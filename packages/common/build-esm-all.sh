#!/bin/bash
excluded_dirs=("test/")

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