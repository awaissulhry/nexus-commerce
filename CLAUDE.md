# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

Nexus Commerce is the back office for selling on Amazon, eBay, Shopify and Etsy: catalog/PIM, listings, stock,
orders, fulfillment and advertising. Several businesses ("business profiles", `Workspace` in code) share one
PostgreSQL database, kept apart by row-level security.

Each app and package below has its own CLAUDE.md; it loads when you open a file there.

## Apps and packages
- `apps/api` — one codebase, three Railway services: the Fastify API (`src/index.ts`), the BullMQ worker
  and the cron scheduler (`src/background.ts worker|scheduler`). Migrations run in Railway's pre-deploy step.
- `apps/web` — Next.js 16 operator console; pages live under `/w/<workspaceId>/…`.
- `apps/factory` — the factory app: own SQLite database and auth, isolated from everything else.
- `packages/database` — Prisma schema, migrations, the workspace-scoped client, row-level-security SQL.
- `packages/events` — the event catalogue (`catalog.ts`) and envelope.
- `packages/shared` — pure logic used by api and web. They import its `dist/`, not its source.
- `services/bidding-engine` — separate service; not an npm workspace, not covered by the checks below.

## Commands (verified 2026-09-26 on main)
    npm ci                                    # fresh clone/worktree only — it deletes node_modules first
    npm run build -w @nexus/shared && npm run build -w @nexus/events   # after npm ci, and after editing either
    npm run dev -w @nexus/api                 # HTTP only; :8080 unless PORT; needs DATABASE_URL, REDIS_URL
    npm run dev:worker -w @nexus/api          # queue consumers; dev:scheduler runs the crons (hard rule 2)
    npm run dev -w @nexus/web                 # :3000; set NEXT_PUBLIC_API_URL to your local API
    npm run typecheck -w @nexus/<api|web|database|shared|events>   # factory: see apps/factory/CLAUDE.md
    cd apps/api && npx vitest run src/path/to/file.vitest.test.ts -t "test name"
    cd apps/web && npx vitest run src/path/to/file.vitest.test.ts
    npm test -w @nexus/database               # reads DATABASE_URL from apps/api/.env
    node scripts/run-real-postgres-tests.mjs  # race/end-to-end suites on a throwaway Docker PostgreSQL 17
    cd apps/web && npx playwright test pressable-row   # needs the web dev server on :3000
    npm run check:drift                       # every Prisma model and column has a migration
    npm run tokens:gen                        # after editing apps/web/src/design-system/tokens/*.ts

- There is no linter. `npm run lint` fails: Next 16 removed `next lint` and there is no ESLint config.
- API tests refuse to start unless `DATABASE_URL` is loopback and names `nexus_development` or a `*test*` database,
  even for tests that never connect. `apps/api/.env` provides it; a fresh worktree has no `.env`, so set one.
- Vitest runs only `*.vitest.test.ts` (and `apps/api/src/**/__tests__/*.test.ts`). Other `apps/api` `*.test.ts`
  files are legacy runners: `npx tsx <file>`.

## Git workflow
- One branch per task, from `origin/main`. Never commit to `main` and never push it; open a PR. Keep PRs small.
- Conventional commits: `type(scope): subject` — `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
- Other sessions work in this checkout at the same time. Here, never switch branches, stash, reset or clean.
  Do branch work in a worktree: `git worktree add -b <branch> /private/tmp/<branch> origin/main`.
  Stage files by name, never `git add -A`.
- `git config core.hooksPath .githooks` enables the pre-push suite. Every check in it is a standalone
  `node scripts/<name>.mjs` whose header states its rule; run the failing one alone.
- Most guards are ratchets: a file may keep the violations it has, may not gain one, and a new file starts at
  zero. Fix the code; never raise a baseline to pass.

## Definition of done
- `npm run typecheck -w <workspace>` passes for every workspace you changed.
- The tests of the changed area pass (the file or directory, not the whole suite).
- Schema changed → a migration in the same PR and `npm run check:drift` passes (packages/database/CLAUDE.md).
- UI: design-system components, and no new Tailwind classes (apps/web/CLAUDE.md).

## Hard rules
1. **Nothing from this machine touches production.** On this machine the root `.env` holds the production
   database and live channel credentials. `apps/api/src/env.ts` loads the CWD `.env` first and then the root
   `.env`, without overriding. So run API tests from `apps/api`, where the test guard refuses non-local databases.
   Run the Prisma CLI only from `packages/database`.
2. **Never run the worker or scheduler (`dev:worker`, `dev:scheduler`) against a shared or production database.**
   They start every queue consumer and cron. On 2026-08-20 one local API, which then started them, doubled
   production order syncs for 7.5 hours.
3. **Set `NEXT_PUBLIC_API_URL` for a local web app.** Unset, `getBackendUrl()` falls back to the production API.
4. **Every marketplace call goes through the channel gateway** (`apps/api/src/services/gateway/gateway.ts`). Account
   state, rate limits and the call ledger live there. The pre-push ratchet holds direct calls at 0.
5. **Classify every Prisma model** in `packages/database/workspaces/model-ownership.json`. An unclassified model
   gets no grant and no policy, and production writes to it fail.
6. **Never run `prisma migrate reset`, `prisma db push` or `prisma migrate dev` against a shared database.** The
   migration history does not replay from zero. The local dev database is shared with other sessions.
7. **Schedule crons only through `apps/api/src/lib/cron/clustered.ts`.** A plain `node-cron` job runs once per replica.
8. **Declare every event type in `packages/events/catalog.ts`.** An undeclared publish throws inside the mutation.
9. **Never hand-edit generated files:** `apps/web/src/design-system/styles/tokens*.css` (`npm run tokens:gen`) and
   `packages/database/*.js` (`npm run build -w @nexus/database`).
