# apps/factory-api — the factory API

The factory's Fastify 5 API: a separate product from Commerce, with its own database, login and Railway projects.
Today the API core: context, contracts, route manifest, security baseline, `GET /health` and `GET /ready`, and
`command()` (`src/core/command.ts`): the ONLY way to write — one transaction for the change, its audit rows, its events
and the idempotency receipt; the outbox (events → BullMQ → handlers and live screens); and the worker and scheduler
(`src/background.ts worker|scheduler`). Sign-in, the modules and the adapters come in later steps.

## Commands (from the repository root unless noted)
    cp apps/factory-api/.env.example apps/factory-api/.env   # once per worktree; loopback values only, your <step>
    cd packages/factory-db && npx prisma generate            # once after npm ci (typecheck and tests need the client)
    npm run dev -w @nexus/factory-api           # :8190 unless FACTORY_PORT
    npm run dev:worker -w @nexus/factory-api    # outbox relay + event handlers; ONLY on this worktree's own database
    npm run dev:scheduler -w @nexus/factory-api # clustered crons; same refusals (start:worker / start:scheduler on dist/)
    npm run typecheck -w @nexus/factory-api
    cd apps/factory-api && npx vitest run       # needs FACTORY_DATABASE_URL: factory_test… or factory_<branch>;
                                                # *.redis.vitest.test.ts and the outbox pg test need the local Redis
    node scripts/factory/run-pg-tests.mjs apps/factory-api   # the *.pg.vitest.test.ts files, on throwaway databases
    npm run build -w @nexus/factory-api         # prisma generate, then esbuild → dist/ (index, background, routes files)
    node scripts/factory/run-guards.mjs         # includes check-route-manifest

## The core (`src/core/`)
- `app.ts`: `buildApp(config, dependencies)` returns a ready instance, or rejects (the process does not start).
  `appConfig(env)` maps the env. Dependencies: `database` (`openFactoryDatabase`), `redis` (ioredis),
  `authenticate`, `routesRoot` (`src/` or `dist/`), `routes` (tests), `logger`, `clock`.
- `context.ts`: the request context per audience (office, floor, partner, link, platform; system for jobs), its
  factory-db scope (`scopeForContext`) and its actor for `can()` (`actorOf`). A route reaches the database only
  through `request.withClient(work)` (= `withContextClient`): no context → 401 before any query.
- `manifest.ts` + `autoload.ts`: every route has a manifest entry `{ audiences, permission, scope }`. Routes live
  ONLY in `src/platform/<name>/routes.ts` (auth, admin, outbox, numbering, …) and `src/modules/<name>/routes.ts`
  (sales, product, …), each with `manifest.ts` beside it: `routes.ts` default-exports
  `defineRoutes(name, manifest, plugin)`, `manifest.ts` holds `defineManifest({...})`. One level of folders; write
  full paths (no prefixes). `routesFiles()` (autoload.ts) finds them for the app, `build.mjs` and the guard alike.
  A route without an entry, an entry without a route, a bad entry, or a route anywhere else stops the boot or fails
  `check-route-manifest.mjs`.
- `build.mjs`: entry points `src/index.ts` + every routes file, ESM with code splitting, so shared code is one
  instance (the build fails if a source file lands in two outputs). `dist/` mirrors `src/`
  (`dist/platform/<name>/routes.js`, chunks beside `dist/index.js`).
- The access check runs before the body is read: session (none → 401) → audience → permission → scope
  (`company`/`site`/`party` from the context; `record` = the handler uses `can()` and `scopeWhere()` from
  `@nexus/factory-domain/core/permissions`).
- `errors.ts`: domain errors (`@nexus/factory-domain/core/errors`) and `ApiError` → `{ error: { code, message,
  requestId, issues? } }` with a stable code. Anything unexpected → 500 `internal_error`, logged, never its message.
- `logger.ts`: redacts secret keys (passwords, PINs, tokens, cookies, keys, hashes, `…Enc`, cost/margin/price/
  amount/total/wages) at any depth; requests are logged by route pattern, never URL, headers or body.
- `security.ts`: strict headers on every answer, CORS only for `FACTORY_WEB_ORIGIN`, writes with another Origin
  refused, rate limit (Redis when present), 1 MiB body limit.
- `ids.ts` (request ids), `time.ts` (the server clock). UUIDv7 `newId()` and Europe/Rome dates live in
  `@nexus/factory-domain/core/{ids,time}`.
- `queue.ts`: BullMQ queues `events`, `event-handlers`, `dead-letter`, every key under FACTORY_QUEUE_PREFIX
  (`openQueues`). `add` needs a deterministic `jobId`; a job that fails its last attempt is copied to `dead-letter`.
- `cron.ts`: `defineCron({ name, schedule, run })` + `startCrons` (scheduler only): each tick claims
  `<prefix>:cron:<job>:<second>` in Redis (SET NX PX); fails closed when Redis is down.
- `sse.ts`: live screens. One Redis subscriber per process (`LiveFeed`), `GET /live` (platform/outbox) streams what
  `liveViewFor` lets each office or floor viewer see; heartbeat 20 s.

## The outbox (`src/platform/outbox/`)
- `writer.ts`: command()'s EventWriter. An emitted event must be declared in `@nexus/factory-domain/events/catalogue`
  (module lists in `factory-domain/src/<module>/events.ts`); an undeclared type or version, or a payload its strict
  schema refuses, rolls the command back. Only this folder writes OutboxEvent rows (`check-event-contract`).
- `relay.ts` (worker): per active tenant, in its system context (office role, RLS forced), `FOR UPDATE SKIP LOCKED`
  → `events` queue (job id = event id) → PUBLISHED; failures back off, DEAD after 10 tries.
- `dispatch.ts` (worker): an event → its live message (Redis pub/sub) + one `event-handlers` job per handler
  (`defineHandler`, listed in `background.ts`; handlers write through `tools.caller` = command() as the system).
- `lag.ts` (scheduler): the `outbox.lag` cron logs pending/dead events, dead letters and failed jobs every minute.

## Rules
- Configuration only through `src/env.ts`. It reads ONLY `apps/factory-api/.env`, by explicit path, and ONLY
  `FACTORY_` variables: never the root `.env` (production credentials on the Owner's Mac), never `DATABASE_URL` or
  `REDIS_URL`. `scripts/factory/check-env-loader.mjs` enforces it.
- `FACTORY_DATABASE_URL` is the runtime login `factory_app`; the boot audits it and refuses a superuser or owner.
- `FACTORY_ENV=local` or `test`: the database and Redis must be loopback, or the API refuses to start.
  `staging` and `production` start only on Railway (`RAILWAY_ENVIRONMENT`, set by the platform, never by the file),
  with an https `FACTORY_WEB_ORIGIN` and a real `FACTORY_COOKIE_SECRET` (32+ characters, not the local placeholder).
- A document number comes only from `allocateNumber(tools, { companyId, kind, code? }, { type, id, date? })` (`src/platform/numbering/allocate.ts`), called in the issuing command's work: it locks the series row, so numbers have no gap and never repeat.
- `testAuthenticator()` is the only way to give a test a session; `buildApp` refuses it unless FACTORY_ENV=test.
- Tests refuse to start unless `FACTORY_DATABASE_URL` is loopback and names `factory_test…` or this worktree's
  `factory_<branch>` (`src/testing/global-setup.ts`), even tests that never connect.
- Local stack: PostgreSQL 17 on 127.0.0.1:5442 and Redis on 127.0.0.1:6399 (`infra/factory/docker-compose.yml`,
  started once from a fixed folder, never from a worktree). Never Commerce's 5432/6379 or Commerce's databases.
- The worker and scheduler run only against this worktree's own loopback database: with FACTORY_ENV local or test,
  `background.ts` refuses any other database name before it connects, and env.ts refuses a missing
  FACTORY_QUEUE_PREFIX (the local Redis is shared; Railway defaults it to `factory`).
- Every event is declared before it is emitted (`check-event-contract`); every schedule is a `defineCron` job
  (`check-cron-clustered`: node-cron only in core/cron.ts, no other scheduler library, no BullMQ repeatable job).
- The Prisma CLI runs only from `packages/factory-db`.
- Vitest runs `src/**/*.vitest.test.ts`; `*.pg.vitest.test.ts` need the local stack.
