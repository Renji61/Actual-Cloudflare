#!/bin/bash
# Signs in to Cloudflare (your browser opens; click Allow), creates the R2
# bucket if needed, and deploys. Output is also saved to logs/deploy.log.
cd "$(dirname "$0")/../.." || exit 1
mkdir -p logs
{
  echo "== started $(date)"
  if npx wrangler whoami 2>&1 | grep -q "You are logged in"; then
    echo "== already signed in to Cloudflare"
  else
    echo "== signing in to Cloudflare: approve the request in your browser"
    npx wrangler login || { echo "== wrangler login FAILED"; exit 1; }
  fi
  npx wrangler whoami
  if npx wrangler r2 bucket list 2>&1 | grep -q "actual-budget-files"; then
    echo "== R2 bucket already exists"
  elif npx wrangler r2 bucket create actual-budget-files; then
    echo "== R2 bucket created"
  else
    echo "== R2 bucket create FAILED (R2 may need to be enabled in the Cloudflare dashboard)"
    exit 1
  fi
  if npm run deploy; then echo "== deploy OK"; else echo "== deploy FAILED"; fi
  echo "== finished $(date)"
} 2>&1 | tee logs/deploy.log
