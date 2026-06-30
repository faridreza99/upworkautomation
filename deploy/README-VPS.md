# UpworkAI — VPS Setup Guide

Complete setup from a **fresh Ubuntu 22.04 LTS** server.

---

## Architecture

```
Browser / Chrome Extension
        │
        │ HTTPS
        ▼
   Nginx (port 443)
   ├── /api  →  Express API  (PM2, port 8080)
   │              ├── PostgreSQL
   │              ├── OpenAI API
   │              └── Telegram Bot API
   └── /     →  Static files (Vite build, no Node process)
```

The dashboard is pre-built by Vite and served as static HTML/JS/CSS by Nginx — no extra Node process required.

---

## 1. Provision the server

Minimum specs: **1 vCPU, 1 GB RAM, 20 GB SSD** (DigitalOcean, Hetzner, Contabo, etc.)

Create a non-root user with sudo:

```bash
adduser upworkai
usermod -aG sudo upworkai
su - upworkai
```

---

## 2. Install system dependencies

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 24 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm
npm install -g pnpm

# PM2 (process manager)
npm install -g pm2

# Nginx
sudo apt install -y nginx

# Certbot (Let's Encrypt TLS)
sudo apt install -y certbot python3-certbot-nginx

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib
```

---

## 3. Set up PostgreSQL

```bash
sudo -u postgres psql

-- Inside psql:
CREATE USER upworkai WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE upworkai OWNER upworkai;
GRANT ALL PRIVILEGES ON DATABASE upworkai TO upworkai;
\q
```

Your `DATABASE_URL` will be:
```
postgresql://upworkai:choose-a-strong-password@localhost:5432/upworkai
```

---

## 4. Clone the repository

```bash
sudo mkdir -p /var/www/upworkai
sudo chown upworkai:upworkai /var/www/upworkai

git clone https://github.com/faridreza99/upworkautomation /var/www/upworkai
cd /var/www/upworkai
```

---

## 5. Configure environment variables

Edit the PM2 ecosystem file with your real secrets:

```bash
nano deploy/pm2.ecosystem.config.cjs
```

Fill in **every** value in the `env:` block:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string from step 3 |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `SESSION_SECRET` | Random 64-char string (`openssl rand -hex 32`) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram user/group ID |
| `PUBLIC_URL` | `https://yourdomain.com` |

Protect the file:
```bash
chmod 600 deploy/pm2.ecosystem.config.cjs
```

---

## 6. Install Nginx config

```bash
# Replace yourdomain.com with your actual domain in the config first:
sed -i 's/yourdomain.com/YOUR_ACTUAL_DOMAIN/g' deploy/nginx.conf

sudo cp deploy/nginx.conf /etc/nginx/sites-available/upworkai
sudo ln -s /etc/nginx/sites-available/upworkai /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default  # remove default site

sudo nginx -t   # must say "syntax is ok"
sudo systemctl reload nginx
```

---

## 7. Get TLS certificate (Let's Encrypt)

Point your domain's DNS A record to the server IP first, then:

```bash
sudo certbot --nginx -d yourdomain.com
```

Certbot will automatically update your Nginx config with the certificate paths and set up auto-renewal.

---

## 8. First deployment

```bash
cd /var/www/upworkai
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

This will:
1. Install dependencies
2. Build the API server (esbuild → `artifacts/api-server/dist/index.mjs`)
3. Build the dashboard (Vite → `artifacts/dashboard/dist/public/`)
4. Run database migrations
5. Start the API server via PM2
6. Reload Nginx

---

## 9. Auto-start PM2 on reboot

```bash
pm2 startup
# Copy and run the command it prints (starts with "sudo env PATH=...")
pm2 save
```

---

## 10. Update the Chrome Extension

Open the extension popup → enter your new Dashboard URL:
```
https://yourdomain.com
```

Click **Save Settings**. The extension will now POST jobs to your VPS API.

---

## 11. Update deployments (future)

```bash
cd /var/www/upworkai
./deploy/deploy.sh
```

---

## Useful commands

```bash
# View API server logs (live)
pm2 logs upworkai-api

# Restart API server
pm2 restart upworkai-api

# View PM2 process list
pm2 status

# Check Nginx errors
sudo tail -f /var/log/nginx/upworkai-error.log

# Check app-level errors
tail -f /var/log/upworkai/api-error.log

# Test API health
curl https://yourdomain.com/api/healthz

# Connect to PostgreSQL
psql postgresql://upworkai:password@localhost:5432/upworkai
```

---

## Firewall (ufw)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Ports 8080 and 23183 should **not** be open externally — Nginx proxies them internally.
