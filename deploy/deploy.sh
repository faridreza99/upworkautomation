#!/usr/bin/env bash
# UpworkAI — VPS deploy script
#
# Run on the VPS from the repo root (/var/www/upworkai):
#   chmod +x deploy/deploy.sh
#   ./deploy/deploy.sh
#
# First-time setup: see deploy/README-VPS.md
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="/var/log/upworkai"

echo ""
echo "═══════════════════════════════════════════"
echo "  UpworkAI — Deploy $(date '+%Y-%m-%d %H:%M:%S')"
echo "  App dir: $APP_DIR"
echo "═══════════════════════════════════════════"
echo ""

cd "$APP_DIR"

# ── 1. Pull latest code ───────────────────────────────────────────────────────
echo "▶ Pulling latest code from GitHub..."
git pull origin main

# ── 2. Install / sync dependencies ───────────────────────────────────────────
echo "▶ Installing dependencies..."
pnpm install --frozen-lockfile

# ── 3. Build API server ───────────────────────────────────────────────────────
echo "▶ Building API server..."
NODE_ENV=production pnpm --filter @workspace/api-server run build

# ── 4. Build dashboard (static) ───────────────────────────────────────────────
echo "▶ Building dashboard..."
# BASE_PATH must match Nginx's root location (/ for root domain)
BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/dashboard run build
echo "   Static files: $APP_DIR/artifacts/dashboard/dist/public"

# ── 5. Run database migrations ────────────────────────────────────────────────
echo "▶ Running database migrations..."
pnpm --filter @workspace/db run push

# ── 6. Ensure log directory exists ───────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── 7. Reload / start API server via PM2 ─────────────────────────────────────
echo "▶ Reloading API server (PM2)..."
if pm2 describe upworkai-api > /dev/null 2>&1; then
    pm2 reload deploy/pm2.ecosystem.config.cjs --update-env
else
    pm2 start deploy/pm2.ecosystem.config.cjs
fi

pm2 save

# ── 8. Reload Nginx to pick up any config changes ────────────────────────────
echo "▶ Testing and reloading Nginx..."
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "✅ Deploy complete!"
echo ""
pm2 status
