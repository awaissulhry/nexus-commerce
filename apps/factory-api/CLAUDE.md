# apps/factory-api — the factory API

The factory's Fastify 5 API: a separate product from Commerce, with its own database, login and Railway projects.
Today a skeleton with one route, `GET /health`. The worker and scheduler (`src/background.ts`), the API core, the
modules and the adapters come in later steps.

## Commands (from the repository root unless noted)
    cp apps/factory-api/.env.example apps/factory-api/.env   # once per worktree; loopback values only
    npm run dev -w @nexus/factory-api           # :8190 unless FACTORY_PORT
    npm run typecheck -w @nexus/factory-api
    cd apps/factory-api && npx vitest run       # needs FACTORY_DATABASE_URL: factory_test… or factory_<branch>
    npm run build -w @nexus/factory-api         # esbuild bundle (build.mjs) → dist/index.js
    node scripts/factory/run-guards.mjs

## Rules
- Configuration only through `src/env.ts`. It reads ONLY `apps/factory-api/.env`, by explicit path, and ONLY
  `FACTORY_` variables: never the root `.env` (production credentials on the Owner's Mac), never `DATABASE_URL` or
  `REDIS_URL`. `scripts/factory/check-env-loader.mjs` enforces it.
- `FACTORY_ENV=local` or `test`: the database and Redis must be loopback, or the API refuses to start.
  `staging` and `production` start only on Railway (`RAILWAY_ENVIRONMENT`, set by the platform, never by the file).
- Tests refuse to start unless `FACTORY_DATABASE_URL` is loopback and names `factory_test…` or this worktree's
  `factory_<branch>` (`src/testing/global-setup.ts`), even tests that never connect.
- Local stack: PostgreSQL 17 on 127.0.0.1:5442 and Redis on 127.0.0.1:6399 (`infra/factory/docker-compose.yml`,
  started once from a fixed folder, never from a worktree). Never Commerce's 5432/6379 or Commerce's databases.
- The worker and scheduler run only against this worktree's own loopback database.
- The Prisma CLI runs only from `packages/factory-db`.
- Vitest runs `src/**/*.vitest.test.ts`.
