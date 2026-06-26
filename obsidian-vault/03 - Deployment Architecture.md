# Deployment Architecture

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Production Stack

```
┌──────────────────────────────────────────────────────────┐
│  VERCEL  (fra1 — Frankfurt)                              │
│  apps/web  — Next.js 16 App Router                      │
│  Triggered by: push to main (turbo ignore skips if       │
│  no web changes)                                         │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  RAILWAY  (europe-west4)                                 │
│                                                          │
│  ┌─────────────────────────────────────────┐            │
│  │  apps/api  — Fastify 5 main API          │            │
│  │  startCommand: prisma migrate + node     │            │
│  └─────────────────────────────────────────┘            │
│                                                          │
│  ┌─────────────────────────────────────────┐            │
│  │  services/bidding-engine  — Fastify 5    │            │
│  │  Separate Railway service                │            │
│  └─────────────────────────────────────────┘            │
│                                                          │
│  ┌─────────────────────────────────────────┐            │
│  │  Neon PostgreSQL  — managed PG           │            │
│  │  DATABASE_URL (with -pooler for app)     │            │
│  │  DATABASE_DIRECT_URL (strip -pooler for  │            │
│  │  prisma migrate deploy)                  │            │
│  └─────────────────────────────────────────┘            │
│                                                          │
│  ┌─────────────────────────────────────────┐            │
│  │  Redis  — Railway managed                │            │
│  │  Used by: BullMQ, rate-limit, session    │            │
│  └─────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────┘
```

---

## Environment Variables (Key)

| Variable | Used By | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | API, web, prisma | Neon Postgres (with `-pooler`) |
| `REDIS_URL` | API, bidding-engine | BullMQ + ioredis |
| `AMAZON_LWA_CLIENT_ID` | API | Amazon OAuth app ID |
| `AMAZON_LWA_CLIENT_SECRET` | API | Amazon OAuth secret |
| `AMAZON_REFRESH_TOKEN` | API | LWA refresh token |
| `AMAZON_SELLER_ID` | API | Seller Central ID |
| `AWS_ACCESS_KEY_ID` | API | SP-API IAM key |
| `AWS_SECRET_ACCESS_KEY` | API | SP-API IAM secret |
| `AWS_ROLE_ARN` | API | IAM role for SP-API |
| `GOOGLE_API_KEY` | API | Gemini AI |
| `CLOUDINARY_*` | API | DAM / image storage |
| `NEXUS_OTEL_ENABLED` | API | Enable OpenTelemetry tracing |
| `NEXT_PUBLIC_API_URL` | web | Fastify API base URL |

---

## Deployment Flows

### API (Railway)

1. Push to `main` → Railway detects `railway.toml`
2. `startCommand` runs:
   - `npx prisma migrate deploy` (runs pending migrations)
   - `node dist/server.js` (start Fastify)
3. Pending migrations block `startCommand` → old container keeps serving until new one is ready
4. Check `scripts/check-migrations-state.mjs` if deploy hangs

### Web (Vercel)

1. Push to `main` → Vercel triggers build
2. `ignoreCommand`: `turbo ignore --filter=@nexus/web` — skips rebuild if no web changes
3. Next.js build runs; output deployed to Vercel edge network (fra1)
4. SSR co-located with Railway API in Frankfurt region

---

## Neon Migration Gotchas

- **Connection string:** Strip `-pooler` from `DATABASE_URL` when running `prisma migrate deploy`
- **Stale advisory locks:** If migration hangs, use `pg_terminate_backend()` to clear locks
- `DATABASE_URL` (with pooler) → app runtime connections
- `DATABASE_DIRECT_URL` (without pooler) → Prisma migrate

---

## Railway Deploy Crash Recipe

If deploy crashes with pending migrations blocking startCommand:
1. Check `scripts/check-migrations-state.mjs`
2. Old container keeps serving — **not a 404**
3. Fix: run pending migration manually or fix schema conflict

---

## Production URLs

- **Railway API:** See [[reference_deployed_urls]] (stored in project memory)
- **Vercel Web:** See [[reference_deployed_urls]] (stored in project memory)

---

## CI/CD

- GitHub Actions (configured in `.github/`)
- Build on commit push to `main`
- Deploy: Vercel web + Railway API in parallel
- Prisma migrations run at container start (not in CI)

---

## Local vs Production Parity

| Concern | Local | Production |
|---------|-------|------------|
| Database | Docker PostgreSQL 15 | Neon managed PG |
| Cache | Docker Redis 7 | Railway Redis |
| Web | `next dev` (port 3000) | Vercel |
| API | `fastify dev` (port 3001) | Railway |
| Migrations | `prisma migrate dev` | `prisma migrate deploy` at start |

> **Rule:** Verify on prod (commit + push), not Docker. Local only for `tsc` / `prisma validate` / `prisma generate`.
