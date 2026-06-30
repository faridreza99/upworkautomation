/**
 * PM2 Ecosystem File — UpworkAI API Server
 *
 * Usage:
 *   pm2 start  deploy/pm2.ecosystem.config.cjs   # first run
 *   pm2 reload deploy/pm2.ecosystem.config.cjs   # zero-downtime reload
 *   pm2 save                                      # persist across reboots
 *   pm2 startup                                   # auto-start on boot
 *
 * NOTE: The dashboard is a static Vite build served by Nginx.
 *       Only the API server runs as a Node process.
 *
 * Fill in all env values below (or use a .env file loaded by your deploy script).
 */

module.exports = {
  apps: [
    {
      name: "upworkai-api",

      // Compiled ESM bundle produced by `pnpm --filter @workspace/api-server run build`
      script: "node",
      args: "--enable-source-maps artifacts/api-server/dist/index.mjs",

      // Absolute path to the repo root on your VPS
      cwd: "/var/www/upworkai",

      instances: 1,       // single instance — scale up if needed
      exec_mode: "fork",  // use "cluster" only with a stateless API
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",

      // ── Environment variables ────────────────────────────────────────────
      // Do NOT commit real secrets here. Either:
      //   a) Fill in values and chmod 600 this file, or
      //   b) Export vars in your shell before running pm2, or
      //   c) Use a .env file and load it with: env_file: "/var/www/upworkai/.env"
      env: {
        NODE_ENV:            "production",
        PORT:                "8080",
        DATABASE_URL:        "postgresql://USER:PASS@localhost:5432/upworkai",
        OPENAI_API_KEY:      "sk-...",
        SESSION_SECRET:      "change-me-to-a-random-64-char-string",
        TELEGRAM_BOT_TOKEN:  "123456:ABC-...",
        TELEGRAM_CHAT_ID:    "6311254113",
        // Public HTTPS URL — used to register the Telegram webhook
        PUBLIC_URL:          "https://yourdomain.com",
      },

      // ── Logging ──────────────────────────────────────────────────────────
      error_file:      "/var/log/upworkai/api-error.log",
      out_file:        "/var/log/upworkai/api-out.log",
      merge_logs:      true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // ── Restart behaviour ────────────────────────────────────────────────
      exp_backoff_restart_delay: 1000, // exponential back-off: 1 s, 2 s, 4 s…
      max_restarts:              10,
      min_uptime:                "5s",
    },
  ],
};
