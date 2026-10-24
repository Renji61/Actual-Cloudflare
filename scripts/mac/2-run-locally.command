#!/bin/bash
# Runs the whole app on this Mac at http://localhost:8787 using Cloudflare's
# local simulator. Nothing is sent to Cloudflare. Close this window to stop it.
# Output is also saved to logs/dev.log.
cd "$(dirname "$0")/../.." || exit 1
mkdir -p logs
npm run dev -- --ip 127.0.0.1 --port 8787 2>&1 | tee logs/dev.log
