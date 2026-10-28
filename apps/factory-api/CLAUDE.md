# apps/factory-api — the factory API

The factory's Fastify 5 API: a separate product from Commerce, with its own database, login and Railway projects.
Today the API core: context, contracts, route manifest, security baseline, `GET /health` and `GET /ready`, and
`command()` (`src/core/command.ts`): the ONLY way to write — one transaction for the change, its audit rows, its events
and the idempotency receipt; the outbox (events → BullMQ → handlers and live screens); and the worker and scheduler
(`src/background.ts worker|scheduler`); office sign-in (`src/platform/auth/`) and the integration platform
(gateway, sealed secrets, inbound ledger), below. Roles, floor, portal and link sign-in, the modules and the adapters
come in later steps.

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
  `defineRoutes(name, manifest, plugin)`, `manifest.ts` holds `defineManifest({...})`. A folder without a routes file
  of its own may group parts one level down (`platform/auth/office/routes.ts`); nothing deeper is loaded. Write full
  paths (no prefixes); test helpers that call `.post('/…')` live in a `testing/` folder (the guard skips it).
  `routesFiles()` (autoload.ts) finds them for the app, `build.mjs` and the guard alike.
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

## Office sign-in (`src/platform/auth/`, plan A1 §3.10)
- `sessions/office-auth.ts`: `createOfficeAuth({ database, environment, cookieSecret, webOrigin, clock?, mailer? })`,
  made in `src/index.ts` and passed to `buildApp` as `officeAuth`: its `authenticate` reads the office cookie (the
  default authenticator), the auth routes read it with `officeAuthOf(app)` (503 without it). Floor, portal and link
  sessions are not read yet: those requests have no session (401).
- Identity is per tenant: `User` (email unique in the tenant), `Session`, `Invitation`, `PasswordReset` (auth.prisma),
  all behind the tenant wall. The tenant is known before any lookup: sign-in names its slug (`factory_platform` reads
  only `Tenant`), cookies and links carry `<tenantId>.<userId>.<secret>`; only SHA-256 of a token is stored.
- Cookies `__Host-factory_session` (HttpOnly, SameSite=Lax) and `__Host-factory_csrf` (readable). Every unsafe request
  of a cookie session, and sign-in, sign-out and invitation accept, send `x-csrf-token` = the CSRF cookie
  (`GET /auth/csrf` makes one). Idle 8 h (slid at most once a minute), absolute 7 days, user and tenant ACTIVE.
- Writes go through command() on the auth object's clock (`auth.command`); the idle slide is the one unaudited write.
- Grants are a placeholder until the roles step: an owner (`User.isOwner`) holds `OWNER_PERMISSIONS` once two-factor is
  proved on the session; everyone else holds none. Risky routes call `requireStepUp(auth, request)` (a TOTP code on
  this session in the last 5 minutes; 403 with issue path `stepUp` otherwise).
- Links never leave the API in an answer or a log: the `AuthMailer` seam (`sessions/mail.ts`, `holdAuthMail` until the
  email step); tests read them from `memoryAuthMailer()` (refused unless FACTORY_ENV=test).
- PostgreSQL tests: `sessions/testing/harness.ts` (`startHarness`, `Browser` cookie jar, `movableClock`, `enrolTotp`,
  `stepUp`). Keep a test file's clock moving forward once a TOTP code was used: an older step is a replay.

## Integrations (`src/platform/{gateway,secrets,inbound}/`, plan A1 §4, §5.4)
- `gateway/`: EVERY call to an outside service is `processGateway().call(gatewayAccount(caller, accountId),
  { name, idempotent, idempotencyKey?, request? }, async (call) => …)`. It re-reads the IntegrationAccount (office or
  system caller only), refuses FAKE in production, PAUSED and DISABLED, an open circuit and an empty rate bucket (Redis,
  `<prefix>:gateway:…`; Redis down = refused), applies the timeout, retries only idempotent operations, and writes ONE
  IntegrationCall row per call (summaries redacted: secrets, personal data, the account's own secret values). Throw
  `ProviderError(message, { httpStatus })` from `fn`. Never call it inside a command's transaction.
  `scripts/factory/check-integration-calls.mjs`: no HTTP client, SDK or fetch() outside `platform/gateway/`,
  `src/adapters/` and `platform/secrets/aws-kms.ts`.
- `gateway/boot.ts`: `assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)` runs at boot in index.ts and
  background.ts, right after openFactoryDatabase: production does not start while any account is FAKE.
- `secrets/`: envelope encryption (AES-256-GCM, a data key per value, wrapped by AWS KMS in staging/production or by
  FACTORY_SECRETS_MASTER_KEY in local/test). `processSecrets().seal/open(…, { tenantId, purpose })`, the `s1.` string
  form for a column of another table, `rotate`; SecretValue rows: `storeSecret(tools, …)` inside a command,
  `readSecret(client, …)`, `rotateSecret(caller, …)`. A value never appears in a row, a log or an audit row.
- `inbound/`: `POST /inbound/<provider>/<tenantId>/<accountId>` (public, raw body): verify (FAKE accounts: the fake
  HMAC verifier; others: INBOUND_PROVIDERS) → InboundWebhook receipt FIRST (dedupe key unique per provider; a bad
  signature is kept as REJECTED) + the event integration.inbound_received in one command → 200. The worker's
  `inboundHandler()` (in background.ts HANDLERS) applies a receipt once with its provider's processor.

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
