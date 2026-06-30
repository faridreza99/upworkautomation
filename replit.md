# UpworkAI — AI-Powered Upwork Automation Dashboard

An AI-powered web dashboard + Chrome Extension that monitors Upwork jobs, scores them with OpenAI, generates proposals, and sends notifications.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/dashboard run dev` — run the dashboard (port 23183)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `OPENAI_API_KEY` — OpenAI API key for AI analysis and proposal generation

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + TailwindCSS + shadcn/ui + Recharts + Framer Motion
- AI: OpenAI `gpt-4o-mini` for job analysis and proposal generation

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle ORM table definitions (jobs, proposals, settings, notifications)
- `artifacts/api-server/src/routes/` — Express route handlers (jobs, proposals, settings, notifications, stats)
- `artifacts/api-server/src/lib/ai.ts` — OpenAI AI decision engine + proposal generator
- `artifacts/dashboard/src/pages/` — React pages (dashboard, jobs, job detail, proposals, notifications, settings)
- `artifacts/chrome-extension/` — Manifest V3 Chrome Extension (content.js, background.js, popup)

## Architecture decisions

- Contract-first OpenAPI → codegen → typed hooks flow: spec gates both frontend and backend
- Single settings row pattern: always insert-or-select one settings record
- AI analysis is triggered async after job submission (from extension or manually from UI)
- Chrome extension uses Manifest V3 service worker; deduplicates by upworkJobId
- Jobs are scored 0–100 across three dimensions: applyScore, riskScore, winProbability

## Product

- **Dashboard** — live stats, score distribution charts, job status pie, recent activity feed
- **Jobs** — filtered list with AI score badges and recommendation tags (Apply/Skip/Review)
- **Job Detail** — analyst-style report: animated score gauges, AI reasoning, strengths/concerns, proposal generator modal
- **Proposals** — draft proposals from AI, approve for sending with one click
- **Notifications** — system alerts for high-score jobs, messages, interviews
- **Settings** — configure min rates, skills, keywords, countries, AI score threshold, auto-apply toggles
- **Chrome Extension** — monitors Upwork pages, extracts job data, sends to dashboard API, shows browser notifications

## Chrome Extension

Load unpacked from `artifacts/chrome-extension/`:
1. Open `chrome://extensions/` → Enable Developer Mode
2. Click "Load unpacked" → select `artifacts/chrome-extension/`
3. Set your Dashboard URL in the popup

## Gotchas

- Always run `pnpm run typecheck:libs` after changing DB schema before typechecking the server
- Codegen must be re-run after any OpenAPI spec change
- Upwork HTML structure changes frequently — content.js selectors may need updating
- `gpt-4o-mini` is used (not `gpt-5`) to keep AI costs low for high-volume job scanning
