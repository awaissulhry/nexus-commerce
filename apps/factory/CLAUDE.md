# apps/factory

Nexus Factory OS: orders → quoting → production → shipping for the leather and moto-apparel factory. It is fully
isolated from the commerce platform.

- **Own database:** SQLite (`data/factory.db`, or `FACTORY_DATABASE_URL`) through Prisma 7 and
  `@prisma/adapter-better-sqlite3`. The client is generated into `src/generated/prisma`. Never connect it to the
  commerce PostgreSQL.
- **Own auth and RBAC:** `src/lib/auth/` (`FACTORY_RBAC_MODE`, default `shadow`). Every API route exports a
  permission and uses `guarded()` (`npm run check:rbac -w @nexus/factory`).
- **Never import** from `apps/web`, `apps/api` or `packages/*`. `npm run check:no-touch -w @nexus/factory` checks the
  two apps only.
- **Design system:** `src/design-system/` is a copy of `apps/web/src/design-system`, so the factory looks the same.
  It is never imported from web.
  - A shared file that is identical in both apps must stay identical (`node scripts/check-ds-fork-drift.mjs --check`
    from the repo root).
  - `npm run check:ds-parity -w @nexus/factory` reports drift. `npm run tokens:gen:factory` regenerates its tokens.

## Commands (verified 2026-09-26 on main)
    npm run setup -w @nexus/factory        # writes .env from .env.example and generates FACTORY_ENCRYPTION_KEY
    npm run db:migrate -w @nexus/factory   # prisma migrate dev on the SQLite file (fine here: local file)
    npm run db:seed -w @nexus/factory
    npm run dev -w @nexus/factory          # web on :3100 + worker
    npm test -w @nexus/factory
    npm run db:generate -w @nexus/factory  # fresh clone: generate the client before typechecking
    npx tsc --noEmit --incremental false -p apps/factory/tsconfig.json   # typecheck without touching the tracked tsbuildinfo

- `db:reset` wipes the factory database and needs `FACTORY_ALLOW_RESET=1`. Ask first.
