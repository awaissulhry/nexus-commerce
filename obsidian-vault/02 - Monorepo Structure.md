# Monorepo Structure

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Workspace Manager

**npm workspaces** (root `package.json`) + **Turborepo** (`turbo.json`) for build orchestration.

```
workspaces:
  - apps/*
  - packages/*
  - services/*
```

---

## Apps

### `apps/api` — `@nexus/api`

| Property | Value |
|----------|-------|
| Framework | Fastify 5.0.0 |
| Runtime | Node.js, ES modules (`"type": "module"`) |
| Language | TypeScript |
| Default Port | 3001 (configurable via env) |
| Entry Point | `src/server.ts` |
| Deployment | Railway (europe-west4) |

See [[04 - API Layer (Fastify)]] for full detail.

### `apps/web` — `@nexus/web`

| Property | Value |
|----------|-------|
| Framework | Next.js 16.2.4 |
| Router | App Router |
| React | 18.2.0 |
| Styling | Tailwind CSS 3.4.0 + PostCSS 8.4 |
| Default Port | 3000 |
| Deployment | Vercel (fra1 Frankfurt) |

See [[08 - Web App (Next.js)]] for full detail.

---

## Packages

### `packages/database` — `@nexus/database`

| Property | Value |
|----------|-------|
| ORM | Prisma 6.19.3 |
| DB Driver | `@prisma/adapter-pg` (pooled connections) |
| Schema | `prisma/schema.prisma` (13,423 lines) |
| Models | 416 |
| Migrations | 310 folders (from 20260422 onwards) |
| Post-install | `prisma generate` runs automatically |

Exports a singleton Prisma Client instance consumed by both `apps/api` and `apps/web`.

See [[05 - Database Schema]] for all models, enums, and relations.

### `packages/shared` — `@nexus/shared`

| File | Purpose |
|------|---------|
| `vault.ts` | Configuration management (secrets / env references) |
| `image-validation.ts` | Image format + dimensions validation (used in bulk uploads) |

Compiled to `dist/` — exports CommonJS + ESM dual build.

---

## Services

### `services/bidding-engine` — `@nexus/bidding-engine`

| Property | Value |
|----------|-------|
| Framework | Fastify 5.0.0 |
| Queue | BullMQ 5.76.2 + ioredis |
| Pattern | Sidekick (no direct DB access) |
| Communication | REST calls to/from main API |
| Deployment | Separate Railway service |

See [[27 - Bidding Engine Microservice]] for full detail.

---

## Turborepo Pipelines (`turbo.json`)

| Task | Behaviour |
|------|-----------|
| `build` | Depends on `^build` (transitive — packages build before apps) |
| `dev` | No caching; persistent (watch mode) |
| `lint` | No outputs |
| Global deps | `.env`, `.env.local` files invalidate cache |

### Scripts (root `package.json`)

```bash
npm run dev        # turbo dev — all apps in parallel with hot-reload
npm run build      # turbo build — dependency-ordered
npm run lint       # turbo lint
npm start          # Prisma migrate deploy + API start (production)
npm run check:drift # Schema drift detection
```

---

## Local Development

`docker-compose.yml` spins up:

| Service | Image | Port | Credentials |
|---------|-------|------|-------------|
| PostgreSQL 15 | postgres:15-alpine | 5432 | user: nexus / pw: nexus_password / db: nexus_commerce |
| Redis 7 | redis:7-alpine | 6379 | — |

```bash
docker-compose up -d   # start local PG + Redis
npm run dev            # start all apps (Next.js on :3000, Fastify on :3001)
```

> **Constraint:** Do NOT use local Docker for verification of production changes. Commit → push → Railway/Vercel live instead.

---

## Configuration Files

| File | Purpose |
|------|---------|
| `turbo.json` | Build pipeline orchestration |
| `docker-compose.yml` | Local dev database + cache |
| `railway.toml` | Production start command (migrate + node) |
| `vercel.json` | Vercel deploy config; `ignoreCommand` via turbo ignore for `@nexus/web` |
| `.env.example` | Required env var template |

---

## Docs & Plans

| Directory | Content |
|-----------|---------|
| `docs/` | 108 markdown spec documents (edit UX, purchase orders, etc.) |
| `plans/` | 52+ blueprint/planning files for feature series |
| `scripts/` | 334+ utility/automation/diagnostic scripts (`.mjs`, `.mts`) |
