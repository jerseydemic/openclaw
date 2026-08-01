#!/usr/bin/env bash
# One-shot deploy for FairPlay -> Cloudflare Workers (static assets + KV).
# Run from anywhere: bash deploy.sh
# Requires Node 18+ and a browser for the one-time `wrangler login`.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Checking Cloudflare auth"
if ! npx -y wrangler@latest whoami >/dev/null 2>&1; then
  echo "Not logged in - opening browser for Cloudflare login..."
  npx -y wrangler@latest login
fi

echo "==> Deploying Worker + static assets"
npx -y wrangler@latest deploy

cat <<'EOF'

==> Deployed.

The URL printed above is your live site.

Next step - enable the moderation queue by setting an admin token:

    npx wrangler secret put ADMIN_TOKEN

Then open <your-url>/#/admin and paste that token to approve submissions.
Nothing submitted is publicly visible until it is approved there.
EOF
