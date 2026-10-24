#!/bin/bash
# Installs dependencies, runs the tests and copies in the Actual web app.
# Double-click in Finder to run. Output is also saved to logs/setup.log.
cd "$(dirname "$0")/../.." || exit 1
mkdir -p logs
{
  echo "== started $(date)"
  echo "== node $(node -v 2>&1), npm $(npm -v 2>&1)"
  if npm install; then echo "== npm install OK"; else echo "== npm install FAILED"; fi
  if npm test; then echo "== npm test OK"; else echo "== npm test FAILED"; fi
  if npm run typecheck; then echo "== typecheck OK"; else echo "== typecheck FAILED"; fi
  if npm run prepare-web; then echo "== prepare-web OK"; else echo "== prepare-web FAILED"; fi
  echo "== finished $(date)"
} 2>&1 | tee logs/setup.log
