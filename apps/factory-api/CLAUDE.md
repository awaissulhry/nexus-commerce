# apps/factory-api — the factory API

The factory's Fastify 5 API: a separate product from Commerce, with its own database, login and Railway projects.
Today the API core: context, contracts, route manifest, security baseline, `GET /health` and `GET /ready`, and
`command()` (`src/core/command.ts`): the ONLY way to write — one transaction for the change, its audit rows, its events
and the idempotency receipt; the outbox (events → BullMQ → handlers and live screens); and the worker and scheduler
(`src/background.ts worker|scheduler`); office and floor sign-in, roles and money grains (`src/platform/auth/`),
one-off links (`src/platform/links/`), the integration platform (gateway, sealed secrets, inbound ledger), files on
R2 (`src/platform/files/`), record threads with the record timeline (`src/platform/threads/`), imports with a dry
run (`src/platform/imports/`), documents and printing (`src/platform/{documents,print}/`), email out through SES
(`src/platform/email-out/`) and email in with "mail to sort" (`src/platform/email-in/`), below. Portal sign-in, the
modules and the other adapters come in later steps.
Modules: `modules/compliance/certificates` (certificate register and gate `certificateGateFor`; cron `compliance.certificateExpiry`).
`modules/inventory/{locations,ledger,stock}`: every stock move goes through `postMoves(tools, drafts, { key })` (ledger/post-moves.ts) inside the caller's command (locks, 409 before below zero, values office/system moves; worker handler `inventory.valueFloorMoves` values floor moves); locations import `inventory.locations`.
`modules/inventory/issue` (B-W1-39): `/inventory/picking/…` pick list, issue (a hide whole; a lot by quantity; over-issue only office + inventory.issue.over), return, undo of one's own last issue (office and floor, inventory.issue), office reversal (inventory.reverse; the ledger's generic reverse refuses ISSUE/RETURN); lock order work-order issue lock → `factory.hide-cut` → stock locks; `issueInCommand` for cutting; handler `inventory.startWorkOrderOnIssue` starts a RELEASED work order (production `startOnFirstWork`).
`modules/shipping/{settings,shipments,packing,ddt}` (B-W1-46, B-W1-47): site settings, office shipments from released garments only (`/shipping/ready`, `/shipping/shipments…`, packing list PDF) and packing for office and floor (`/shipping/packing…`, shipping.pack); every write is a command on the Shipment (its version bump locks the row), then `cells.ts` takes the `factory.ship-cell` locks sorted and answers 409 before the trigger; the DDT (office: `…/ddt/preview`, `POST …/ddt` with optional `ship`, `POST …/ship`, `/shipping/ddts…` read, PDF, cancel; shipping.ddt.issue | cancel) takes its number with allocateNumber inside the issuing command on the Shipment (one live DDT per shipment under that lock), is append-only (a cancellation keeps the number; refused while an issued invoice's line names the DDT, DRAFT ones only warn) and its PDF (FISCAL_ARCHIVE) is stored after the commit (`POST /shipping/ddts/:id/pdf` prints a missing one).

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
  made in `src/index.ts` and passed to `buildApp` as `officeAuth`: its `authenticate` reads a one-off link's token
  (`x-factory-link`, platform/links), else the floor session cookie (the floor authenticator, below; no office
  fallback), else the office cookie (the default authenticator); the auth and link routes read it with
  `officeAuthOf(app)` (503 without it). Portal sessions are not read yet (401).
- Identity is per tenant: `User` (email unique in the tenant), `Session`, `Invitation`, `PasswordReset` (auth.prisma),
  all behind the tenant wall. The tenant is known before any lookup: sign-in names its slug (`factory_platform` reads
  only `Tenant`), cookies and links carry `<tenantId>.<userId>.<secret>`; only SHA-256 of a token is stored.
- Cookies `__Host-factory_session` (HttpOnly, SameSite=Lax) and `__Host-factory_csrf` (readable). Every unsafe request
  of a cookie session, and sign-in, sign-out and invitation accept, send `x-csrf-token` = the CSRF cookie
  (`GET /auth/csrf` makes one). Idle 8 h (slid at most once a minute), absolute 7 days, user and tenant ACTIVE.
- Writes go through command() on the auth object's clock (`auth.command`); the idle slide is the one unaudited write.
- Every office secret (session and CSRF token, invitation and reset token, TOTP secret, recovery codes) is minted
  BEFORE its command and is never in its input, result or audit row (sign-in and resets hand only the hash in:
  `createSession`, `createPasswordReset`); `invitations/tokens.pg.vitest.test.ts` gives each office auth command a
  receipt and scans it.
- Grants come from the person's live role assignments (below), read on every request (`sessions/grants.ts`). Risky
  routes call `requireStepUp(auth, request)` (a TOTP code on this session in the last 5 minutes; 403 with issue path
  `stepUp` otherwise): every permission declared with risk `stepUp` does.
- Links never leave the API in an answer, a stored row or a log: the `AuthMailer` seam (`sessions/mail.ts`), by default
  email out's `emailAuthMailer` (below); tests read them from the harness's fake SES mailbox (`h.mailer.last(kind, to)`).
- PostgreSQL tests: `sessions/testing/harness.ts` (`startHarness`, `Browser` cookie jar, `movableClock`, `enrolTotp`,
  `stepUp`). Keep a test file's clock moving forward once a TOTP code was used: an older step is a replay.

## Roles, permissions and money grains (`src/platform/auth/roles/`, plan A1 §2.3, §2.6, §3.11)
- Every permission is declared once in `@nexus/factory-domain/auth/permissions` (`definePermissions('<area>', {…})`,
  assembled in `catalogue.ts` with a description and a risk: read, write, stepUp). The app refuses to boot a routes
  file whose manifest names an undeclared one (`core/app.ts`; test routes passed in `routes` are not checked). A module
  that adds routes declares its permissions in the same PR and gives them to the templates that need them.
- Role templates (`@nexus/factory-domain/auth/roles/templates`): office owner, admin, finance, sales, planner, buyer,
  warehouse, production_manager, quality_inspector, floor_supervisor, read_only; floor (audience FLOOR, given to floor
  workers, never to people) operator, cutting_operator, floor_inspector, team_leader: only `floor.*` permissions, at
  most wages, no two-factor. Office roles never hold `floor.*`; custom roles are office roles. Each tenant has them as system Role
  rows, synced with the templates for every ACTIVE tenant when the worker starts and by the daily clustered cron
  `roles.syncTemplates` (`roles/sync.ts`, in each tenant's system context), at tenant set-up and the seed, and on demand
  by `POST /auth/roles/sync-templates`; one audit row per changed role. Custom roles (`custom.<key>`) are copies the
  tenant edits; a template change never widens them (the list shows `templateAdds`).
- RoleAssignment: one role for one person over every company or a list, optional sites and parties, from/to; ended,
  never deleted. A session holds the union (one Grant per live assignment); a role with `requireMfa` gives nothing
  until two-factor is proved on the session. A person gives and ends roles only within their own `roles.assign` scope
  (companies, sites, parties): a wider assignment or invitation, or ending one their scope does not wholly reach, is a
  403. Nobody gives themselves a role or edits one
  they hold; the tenant keeps an administrator (an ACTIVE person with `roles.assign` over every company): users'
  suspend/deactivate, ending an assignment and editing a role all refuse to remove the last one.
- Money grains (price, cost, margin, wages) travel in grants as the permissions `money.<grain>`; floor sessions hold at
  most wages, partner and link sessions at most price. A contract field that carries money is `money.<grain>(schema)`
  (`@nexus/factory-domain/money/marked`: optional, typed `Money<grain>`; return it with `asMoney`); free JSON holding
  money uses `markMoney(grain, value)` (audit before/after) inside a `grainedJson()` field. `roles/grain-filter.ts`
  (installed by `core/app.ts`) drops unheld marked fields from every answer and refuses a body that sends one.
  `check-money-grains` fails on an unmarked money-looking contract field, audit value or Prisma column.
- PostgreSQL tests: the harness's `addTenant` gives a tenant its system roles; `addUser({ role: 'owner' })` and
  `addRole(h, tenant, userId, key)` give a system role over every company.

## Floor sign-in (`src/platform/auth/floor/`, plan A1 §3.8, §3.10 "Floor")
- Tables (floor-auth.prisma): Device, DeviceEnrolment, Worker (+ PIN hash and lockout), Badge, WorkerRole (a worker's
  FLOOR roles), FloorSession, FloorSettings (per site, its id = the site's id). Everything a tablet does runs in the
  FLOOR scope (`factory_floor_runtime`) of the device token's tenant and site: the device (or the enrolment code) is the
  actor until an operator is signed in, then the worker. Office administrators keep them in the office scope.
- Secrets: device token `<tenantId>.<siteId>.<deviceId>.<secret>` (cookie `__Host-factory_device`, 400 days),
  enrolment code `<tenantId>.<siteId>.<enrolmentId>.<secret>` (QR code of a web link, 15 minutes, once), floor session
  token (cookie `__Host-factory_floor`, until the shift end), badge code (128 bits, Crockford base32): SHA-256 only.
  The PIN: HMAC-SHA-256 with the server's pepper (`FACTORY_PIN_PEPPER`, required in staging and production; a
  placeholder locally), then scrypt, stored `$pin$<pepper id>$scrypt$…`; `FACTORY_PIN_PEPPER_PREVIOUS` still opens
  older hashes during a rotation (re-hashed at the next sign-in). `auth.pins` is the keyring. Every secret is minted
  BEFORE its command and never enters its input, result (receipts keep results) or audit row; the Office's enrol,
  new-code, badge and PIN-reset routes take an Idempotency-Key, and a repeat answers from its receipt with the secret
  `null` (`invitations/tokens.pg.vitest.test.ts` scans receipts, audit rows and events for each floor secret). Unsafe
  floor routes pass the office CSRF double submit.
- `floor/authenticator.ts` (wired in `sessions/office-auth.ts`): the floor session cookie → floor authenticator, no
  office fallback. Live = the device token matches an ACTIVE device, the session is the device's `currentSessionId`
  (one operator per device), not ended, before its idle end (site setting, default 10 minutes, slid at most once a
  minute) and its shift end (first site shift end at least 30 minutes after sign-in, at most 12 hours); worker ACTIVE,
  its badge (if any) ACTIVE. Grants: the worker's live FLOOR roles over the device's company and site, grains capped to
  wages (`factory-domain auth/floor/grants`); none while `pinMustChange`.
- Sign-in: badge + PIN or worker id (name) + PIN; one uniform 401 for every failure; 5 wrong PINs lock the worker
  (5 minutes, doubling, not the device). Another worker live on the device → 409 (use `POST /floor/switch`); the same
  worker → REPLACED; an expired one → closed (IDLE, SHIFT_END). The device row is locked (`FOR UPDATE`) in the command.
- Floor commands use `floorCommand` (store.ts): a fresh server Idempotency-Key each (a sign-in is never a replay).
- Revoking a device or badge, deactivating a worker or resetting a PIN ends the sessions (`endSessions`); the
  authenticator re-checks each on every request anyway. Office routes `/auth/floor/*` are scoped by record (can() on
  the device's, worker's or site's company and site; scopeWhere() for lists); nobody manages the roles, badge or PIN of
  the worker linked to themselves. A worker's floor roles (`workers.roles`, also when a worker is made with roles) and
  credentials (`workers.credentials`: badges, PIN reset) are step-up permissions: `requireStepUp` after the record and
  scope checks.
- Legal: a worker is a name, language, optional employee number, site, status, badge and PIN hash (GDPR art. 5(1)(c));
  no biometric, photo, birth date or national id (MES-276); no productivity figure, and the registry shows "in use",
  never who (Statuto dei Lavoratori art. 4). The PG tests that prove it name these articles.

## One-off links (`src/platform/links/`, plan A1 §3.10 "Links", §2.2; features SAL-099, PLT-007, PLT-035)
- A link opens ONE record of ONE party for ONE purpose (factory-domain `links/purposes`: QUOTE_ACCEPT, PO_CONFIRM,
  DOCUMENT_VIEW, DEPOSIT_INFO), with an expiry and a use limit. Token `<tenantId>.<partyId>.<linkId>.<secret>` (256
  bits, `links/token`); only its SHA-256 is stored. The web link is `<web>/l#token=…` (fragment: in no server log); the
  web sends the token in the `x-factory-link` header.
- `authenticator.ts` (chained before the office cookie): the link is read in the token's PARTY scope
  (factory_partner_runtime), hash compared in constant time, live (not revoked, not expired, uses left), tenant
  ACTIVE → context `link` with its one record and the grants of its purpose (never a role's: `links.open`, its answers
  `links.accept|decline|confirm`, `money.price` only for purposes that show the party its own document; PO_CONFIRM
  none). Anything else is ONE 404 (`LINK_UNAVAILABLE`), whatever was wrong. `linkSessionOf(request)` gives the link.
- Every use goes through `useLink(tools, request, { action, typedName?, email? })` INSIDE a command (`linkCommand`, on
  the sign-in clock): the purpose's evidence rules (`links/evidence`: typed name, email check), the use counted by one
  UPDATE that matches only a live link (a race uses a one-use link once), a LinkEvidence row (append-only), an audit
  row and the `link.used` event. Link writes need an Idempotency-Key. A module's answer route (W1: accept a quote,
  confirm a PO) has the `link` audience, its action's permission and scope `record`, and calls useLink beside its
  change; command() refuses any record but the link's.
- Office: `POST /links` (links.manage over the record's company and party; the URL is in the answer once, never in the
  command result, so no receipt holds it), `GET /links?recordType=&recordId=` (links.view, scopeWhere), `POST
  /links/:linkId/revoke` (final). A record type is linkable only once its module registers a source
  (`records.ts`, `registerLinkRecordSource`); W0 has none. Rate limit `AuthRateLimits.linkUse` on link routes.
- The partner wall (factory-db `src/ownership.ts`): a column marked `/// @grain cost|margin|wages` or `/// @internal`
  must be in the partner role's hiddenColumns (check-ownership). The OneOffLink guard trigger keeps a link fixed but for
  its uses, revocation and note.
- PostgreSQL tests: `links.pg.vitest.test.ts` (a made-up module with in-memory records registers sources and link
  routes), `guards.pg.vitest.test.ts`.

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
  `inboundHandler()` (in background.ts HANDLERS) applies a receipt once with its provider's processor. INBOUND_PROVIDERS:
  SES (SNS: basic-auth verifier; processor: platform/email-in's for "Received", in front of platform/email-out's).

## Files on R2 (`src/platform/files/`, `src/adapters/{r2,local-files}/`, plan A1 §3.6; COL-045, COL-050, PLAN §2.8)
- `StoredFile` (files.prisma): one row per file, for ONE record (`recordType` + `recordId`), never the bytes. Flow:
  `POST /files` (kind's types and size limit, sharing, retention) → files.requestUpload (PENDING_UPLOAD, random key
  `t/<tenant>/c/<company>/<yyyy>/<uuid4>`, `legal/…` for FISCAL_ARCHIVE) → a presigned PUT (5 min; type, length and
  SHA-256 signed) → `POST /files/:id/complete` (the store's HEAD) → AVAILABLE + event `file.available`, or QUARANTINED
  with its reason → `GET /files/:id/download` (60 s presigned GET, always an attachment). Rules: `rules.ts` (pure).
- Visibility (COL-050): OFFICE always; FLOOR with `floorSiteId`, PARTNER/LINK with `partyId`. Those two columns are the
  floor and partner roles' policy keys, set exactly when shared (the …_files_guards trigger), so RLS keeps a floor to its
  site's floor files and a party to its own; `audienceSees()` adds portal vs link (LINK also needs the link's record).
- Retention: a delete is refused under legal hold or before `retainUntil` (the state machine's guard and the trigger);
  FISCAL_ARCHIVE keeps ten years at least; content columns never change; rows are never deleted (status DELETED).
- Store calls go through the gateway (`store.ts`: files.presign_upload, files.presign_download, files.head, files.delete,
  files.read (server-side work on a file's bytes, e.g. an import's sheet, size-capped); one IntegrationCall row each)
  for the tenant's R2 account: LIVE/SANDBOX → `adapters/r2` (S3 API), FAKE → the local
  store (`adapters/local-files`, local and test only; its presigned requests are `PUT|GET /local-files?token=…` on this
  API, HMAC-signed). Floor, portal and link downloads presign as the tenant's system caller after the audience check.
  Tests: `useFiles(createFilesRuntime({ gateway, local, r2: r2FileStore({ clientFor: new FakeR2().clientFor }) }))`
  (`adapters/r2/testing.ts`: the real S3 client on an in-memory transport, no network).
- Permissions (declared in `@nexus/factory-domain/auth/permissions/catalogue`, FILES_DEFINITIONS): files.read,
  files.upload, files.delete, files.manage (sharing beyond the office, also at upload; retention; legal hold). Every
  office template has files.read; the roles that work on records also files.upload; admin (and owner) files.manage and
  files.delete. Floor, portal and link sessions see files through their audience rule above, never an office template.

## Record threads and the timeline (`src/platform/threads/`, plan A1 §2.3, §3.7; COL-001, COL-002, COL-003)
- `Thread` (threads.prisma): ONE per record (`recordType` + `recordId`, unique per tenant), made with its first message
  by `ensureThread` (INSERT … ON CONFLICT DO NOTHING: racing first posts share one row). Its company, site and party are
  the RECORD's, read by a resolver per record type in `records.ts` (`THREAD_RECORDS`; W0: Company, Site), never sent by
  the caller: a module adds its record types there with its thread panel; an unknown type is a 404. `replyToken`
  (26 lower-case base32, unique across tenants) is the reply address's secret part; it never leaves the API.
- `Message`: append-only (`@append-only`, the …_threads_guards triggers). INTERNAL_NOTE, and only it, is OFFICE; OUTBOUND
  and INBOUND are PARTNER and carry `partyId` = the thread's party (the partner role's policy key; the reference
  (tenantId, threadId, partyId) → Thread pins it), so an internal note never reaches a party. Attachments are StoredFile
  ids of the SAME record (checked at write: AVAILABLE, the writer's files.read, and for a shared message shared with the
  thread's party); each reader sees only the attachments its own file rules allow (RLS, `audienceSees`, can()).
- Routes: `GET /threads/:recordType/:recordId` (office; partner and link: the shared messages of their party, a link only
  its record), `POST …/notes` (threads.post; mentions: ACTIVE people whose roles read the thread), `PUT …/status`
  (threads.manage: close and reopen, version-guarded), `GET …/timeline` (office). Pages newest first; `nextCursor`.
- The timeline is computed at read time, not stored: the record's AuditLog rows + its thread's messages + its files
  (`availableAt`), merged by (time, id) (factory-domain threads/timeline). A change shows its action, actor, status move
  and changed field names to threads.read; its values only with audit.read over the row, money only with its grain.
- Events `thread.message_posted` (live: threads.read) and `thread.user_mentioned` (one per person; no live rule: the
  notification centre consumes it).
- The email steps write through the same seam inside their own command: `ensureThread`, `attachmentProblems(…,
  'PARTNER')`, `writeMessage` with direction OUTBOUND (the mail's delivery state is their own table; Message never
  changes) or INBOUND (`bodyHtml` sanitised, `emailMessageId` unique per tenant). The seam checks no permission.

## Imports with a dry run (`src/platform/imports/`, plan A1 W0-22; PLT-176)
- Engine only in W0; business importers come with their modules. An importer = `defineImporter` in
  `@nexus/factory-domain/imports/importer` (key `<module>.<name>`, columns with `cell.*` types (Italian/English numbers,
  day-first dates), aliases, required, `grain` for money; `keyColumns` for upsert matching; optional `validateRow`,
  `plan`) + `defineImportAdapter` here (`permission`, `viewPermission`, `load` = the records the keys find, read only;
  `write` = one planned row inside the batch's command, audited, money marked). Add the adapter to `IMPORTERS`
  (`registry.ts`, one line); tests use `useImporters([...])`.
- Flow: `POST /imports` (importer, company, mode DRY_RUN|APPLY, sheetName, encoding, numberFormat, header `mapping`, the
  sheet announced as a file: needs imports.run, the importer's permissions and files.upload) → PUT the bytes → `POST
  /files/:fileId/complete` → `file.available` → worker `imports.planUpload`: read the sheet (`sheet.ts`: CSV UTF-8 or
  Windows-1252, `;`/`,`/tab; xlsx first or named sheet, formulas as values, macros and zip bombs refused), map headers,
  refuse money columns outside the creator's grains (`ImportJob.grains`), plan in batches (`load` in a transaction that
  is always rolled back and refused if it wrote) → PLANNED. Review: `GET /imports/:id`, `/rows` (before/after money only
  with its grain), `/errors` (CSV, never cell values). `POST /imports/:id/apply` (imports.apply, the importer's
  permission, the grains of the mapped money columns) → `import.apply_requested` → worker `imports.applyPlan`: batches
  of the importer's batchSize, each ONE command (job row locked; rows changed since the dry run SKIPPED, never
  overwritten); a throw rolls back its batch and, after the last attempt, fails the job; apply again resumes.
  `POST /imports/:id/cancel`. Handlers are in background.ts HANDLERS (`importHandlers()`).
- Permissions: imports.view (read), imports.run, imports.apply (write); admin's template has all three (owner and
  read-only follow the registry). A module that adds an importer gives imports.* to the templates that use it.
- An adapter's optional `authorize(actor, job, columns)` adds refusals (issues; never fewer checks): called at the start
  (the mapping's columns), in the dry run (the starter's live roles, two-factor taken as proved; the job fails with the
  issues) and at the apply (the person who applies). The materials importer uses it for its routes' rules.

## Modules
- Product › materials (`src/modules/product/materials/`, B-W1-09): office routes `/product/materials…` (product.materials.view | manage | cost; the standard cost has its own PUT route, money.cost to send or see it), the `product.materials` importer in IMPORTERS; the rules and unit conversions are factory-domain `product/{materials,units}`; every read names its columns (`store.ts`); no floor route (the floor reads materials through its work orders).
- Product › BOM (`src/modules/product/bom/`, B-W1-13): office routes `/product/styles/:styleId/revisions/:revisionId/bom…`, `…/copy`, `…/release`, `…/obsolete`, `PATCH …/revisions/:revisionId` and `/product/styles/:styleId/bom/compare` (product.bom.view | manage | release); every write sends the revision's `version`: lock the style row, check the revision is a DRAFT (409 first), compare-and-set the revision, then the parts (`store.ts lockDraft`); rules and math in factory-domain `product/bom` (`planLine`, `bomIssues`, `requirements`); release obsoletes the old RELEASED revision first and makes a DRAFT style ACTIVE.
- Product › routing and operations (`src/modules/product/{routing,operations}/`, B-W1-14): office routes `/product/styles/:styleId/revisions/:revisionId/routing…` (steps add/edit/remove, `order`, `copy` from a RELEASED routing), `/product/styles/:styleId/routing/compare`, `/product/operations…` (product.routing.view | manage, product.operations.manage); routing writes take the BOM's lock order (lockStyle → revision CAS → Operation rows FOR SHARE → steps; `routing/store.ts lockDraft`), a reorder parks moving steps at -seq first; rules and minutes in factory-domain `product/routing` (`routingMinutes`, `routingIssues`, `finalStepOf` = last scanned step); operations are archived, never deleted.
- Product › styles (`src/modules/product/styles/`, B-W1-11): office routes `/product/styles…` and `/product/size-scales…` (product.styles.view | manage): styles, colourways, the colour x size SKU matrix (generate, follow the range and colourways, cells on/off, GTIN), DRAFT revision shells, size scales; rules in factory-domain `product/{styles,sizes}`; lock the style (or scale) row first, then compare-and-set the child's version (`store.ts`); `Style` has a thread.
- Planning (`src/modules/planning/`, B-W1-29): office routes `/planning/runs…`, `/planning/requirements…`, `/planning/unusable-stock` (planning.view | run | decide); a run is ONE command (`run.ts`: the site's planning lock without waiting, else 409; RUNNING → lines → older DONE SUPERSEDED → DONE; any other failure becomes a FAILED run of its own); the math is factory-domain `planning/*` (the BOM explosion reuses `product/bom/requirements`); purchasing (B-W1-30) calls `hooks.ts` (proposalFor, orderRequirement, unorderRequirement) inside its own command.
- Costing (`src/modules/costing/`, B-W1-16): office reads `/costing/styles/:styleId/revisions/:revisionId/cost-sheet`, `/costing/styles/:styleId/cost-sheet/compare`, `POST /costing/cells` (costing.view; every figure money.cost, dropped without the grain); computed on read from the BOM (bom/store readLines) and routing (routing/read readSteps) with factory-domain `costing` (`prepareSheet`, `exactCell`, `quantityCost`: exact to the end, one rounding per figure; a missing input is listed and the cell's total is null, never 0); labour rates (`LabourRate`) and the overhead (`CostingSettings`, keyed by the company's id or the tenant's) are kept by `/costing/rates…` and `/costing/settings` (costing.rates.manage; a rate needs the cost grain) and read through `inputs.ts` (`processCostingInputs`: the tables; tests may swap it with `useCostingInputs`).
- Production › floor rules (`src/modules/production/settings/`, B-W1-37; MES-278): office routes `/production/settings…` (production.settings.view | manage; naming workers needs a legal basis on record; widening STATION → WORKER also a reason and a step-up, narrowing never asks; who has not acknowledged the notice by name only with manage) and floor `GET /production/floor-rules` (floor.work: its site's subject, never the basis); cutting and scans call `subject.ts` (`scanSubjectFor`, `floorRecordSubjectFor`: 409 in words before the triggers) inside their command; rules in factory-domain `production/settings/monitoring`.
- Production › work orders (`src/modules/production/work-orders/`, B-W1-38): office routes `/production/work-orders…` (workorders.view | manage | release): a DRAFT from sales order lines (WORK_ORDER series; cells ≤ what is open per line × size, advisory lock per line), cells/revision only while DRAFT, the release check = THE release's check (`facts.ts checklistOf`; rules in factory-domain `production/work-orders`), release = one command (WO version bump → site release advisory lock → Style FOR SHARE → check → frozen ops/materials → BATCH number → RELEASED; 409 with every blocker first), start/complete/close/cancel, spec vs master; made-to-measure lines 409 (B-W1-17/18 deferred).
- Parties (`src/modules/parties/`, B-W1-07): office routes `/parties…` (parties.view | manage | block | vies) for customers AND suppliers (one record, roles); can() on company AND party (`mayWrite`: tenant-wide only by a grant over every company); lock the party first (`lockParty`), then CAS the address/contact/identity version; defaults move the party's version; `assertNoTaxDuplicate` (advisory lock per number) refuses another party's VAT number or codice fiscale; VIES checks: ONE gateway call `vies.check_vat` (adapters/vies: soap LIVE/SANDBOX, FakeVies: …8 invalid, …9 no answer) then command `parties.checkVies` writes the append-only ViesCheck (no answer = ERROR, standing HELD); proof rules factory-domain `parties/vies` (30 days); importer `parties.parties` in IMPORTERS; tests `useVies(createViesRuntime({ gateway, fake }))`.
- Invoicing + payments (`src/modules/{invoicing,payments}/`, B-W1-28): office routes `/invoicing/invoices…` (invoices.view | manage | issue, issue = step-up) and `/payments…` (payments.view | record | void); can() on company AND buyer; core = factory-domain `invoicing/{invoices,checks,document,deposit}` + `payments/payments`; issue = (a) command: money locks (payments/locks.ts: payment → deposit/invoice, id order) → checks again → allocateNumber → number fields, seller, billTo (+ billTo.vies proof), partyId; (b) XML + PDF built outside any tx and put (platform/files `putGeneratedFile`); (c) attach command (`recordGeneratedFile`, xmlFileId/pdfFileId) — b/c failing leaves ISSUED + filesPending, finished by `POST …/:id/files` or worker handler `invoicing.files` on invoice.issued; `POST /payments/deposit-received` = payment + allocation (capped) + request PAID (`markDepositPaid`, here until sales has one) + TD02 when `depositInvoiceDecision` requires it, one command.

## Documents and printing (`src/platform/{documents,print}/`, `src/adapters/print-relay/`, plan A1 §3.9; GAP-007, GAP-008)
- Documents: the issuing module builds its frozen document (`@nexus/factory-domain/documents`: QUOTE, PURCHASE_ORDER,
  DDT, INVOICE_COPY; it, en) and calls `storeDocumentPdf(processFiles(), caller, { companyId, recordType, recordId,
  document })` after its own permission check: the company's c.c. art. 2250 data comes from its Company row, never a
  request; `composeDocument` refuses an incomplete document (legal data, DPR 472/1996 for a DDT, totals that do not add
  up); `pdf.ts` paints it with pdfkit's standard fonts (same input, same bytes); `files.storeGeneratedFile` puts it in
  the store (gateway op files.put) and records it AVAILABLE in one command `documents.render` — FISCAL_ARCHIVE (ten
  years) for DDTs and invoice copies, DOCUMENT otherwise. The invoice PDF is a courtesy copy and says so (the legal
  invoice is the FatturaPA XML). `GET /documents/sample` (documents.view) previews each layout with a company's data.
- Labels: `@nexus/factory-domain/labels` composes HIDE, LOT, BUNDLE and CARTON labels (the scannable id must be the
  tenant's, of the label's kind) and makes ZPL (`^BC` Code 128 + the id as text); `documents/label-pdf.ts` draws the same
  label as a PDF with Code 128 bars (`POST /print/labels/pdf`, the browser's fallback, stored nowhere).
- Printing: `Printer` (site, kind LABEL_ZPL | A4_PDF, relay, relay target, label stock, ACTIVE | PAUSED | ARCHIVED) and
  `PrintJob` (print.prisma). `POST /print/jobs/label|document` → `print.queue` (QUEUED + event print.job_queued) → the
  worker's `printDispatchHandler()` (in background.ts HANDLERS) hands it to the printer's relay → SENT
  (`print.markSent`); a refused try is counted (`print.recordAttempt`) and retried with backoff; FAILED after 5 tries or
  a final refusal (`print.fail`); a relay's report → PRINTED or FAILED (`applyRelayReport`); `POST
  /print/jobs/:jobId/retry` queues a FAILED job again. A floor device prints and lists only at its own site (row-level
  security; an idempotency key is required).
- Relays: `adapters/print-relay/port.ts` (submit is idempotent by job id). Only FAKE exists (`fake.ts`: records, sends
  nothing; local and test only): which relay a site gets is the Owner's question (A1 §9 q. 5). Without a relay the
  browser prints the PDF. Tests: `usePrintRelays(printRelays({ FAKE: fakePrintRelay({ environment: 'test' }) }))`.
- Permissions: documents.view; print.view, print.labels, print.documents, print.manage (printers).

## Email out (`src/platform/email-out/`, `src/adapters/ses/`, plan A1 §3.3, §3.7; PLT-139, PLT-149, PLT-230, COL-024, GAP-005)
- Tables (email.prisma): EmailIdentity (a company's verified SES domain: kind CONVERSATION for record mail, NOTIFICATION
  for sign-in mail; From-line policy COMPANY | PERSON_VIA_COMPANY | PERSON_ADDRESS; reply domain; its SES account; the
  company's default per kind), EmailOutbound (who, from which identity, subject, Message-ID, In-Reply-To/References,
  status QUEUED → SENDING → SENT → DELIVERED / BOUNCED / COMPLAINED, or FAILED; NO body), Suppression (tenant-wide).
  The …_email_guards trigger keeps what a mail sends fixed and its status moving forward; nothing is deleted.
- Send from a module's command: `sendEmail(tools, { record, sender, to, cc?, bcc?, subject?, body, attachments?,
  identityId?, locale? })` (outbound.ts): ensureThread → attachmentProblems(PARTNER) and at most 10 MB of attachments
  together (MAX_ATTACHMENT_BYTES) → suppression check → writeMessage
  (OUTBOUND, EMAIL, `emailMessageId: <outboundId@identity domain>`) → EmailOutbound QUEUED → event `email.queued`, one
  transaction. Route: `POST /threads/:recordType/:recordId/emails` (email.send). `GET …/emails` lists them (threads.read).
- The worker's `emailSendHandler()` (background.ts HANDLERS) runs `deliverOutbound`: claim (QUEUED, or SENDING with a
  lapsed claim → SENDING, one try counted; suppression and identity re-checked) → MIME (factory-domain email/compose +
  mime: the message text, the sender's signature, the attached files (bytes read here, in the worker, through the file
  store: one `files.read` gateway call each; still AVAILABLE and shared with the party), the footer with the c.c. art.
  2250 block as the documents print it (documents/legal.ts on platform/documents `companyLegalOf`: liquidation, single
  shareholder …) and the privacy-notice slot `<FACTORY_WEB_ORIGIN>/privacy/<companyId>`; Reply-To
  `r-<thread replyToken>@<replyDomain>` read here only) → ONE gateway call `mail.send` (non-idempotent; the ledger keeps id, template, recipient count and
  size, never an address) → SENT. A failed try → QUEUED and the job retries (MAX_SEND_ATTEMPTS 5), else FAILED.
- Sign-in mail (`auth-mail.ts`, the default AuthMailer): composed in memory with the link, an EmailOutbound row without
  body (record `User`), sent at once through the same deliverOutbound from the tenant's default NOTIFICATION identity,
  never retried by a job (the person asks again). No thread, no Reply-To, `Auto-Submitted: auto-generated`.
- SES notifications (`notifications.ts`, via platform/inbound): Delivery → DELIVERED; Bounce Permanent → BOUNCED + the
  addresses suppressed; Transient → noted only; Complaint → COMPLAINED + suppressed. A later event only makes it worse.
- Identities: `GET /email/identities` (email.send), `POST /email/identities`, `POST …/:id/check`, `PUT …/:id`
  (email.manage, step-up): SES CreateEmailIdentity / GetEmailIdentity through the gateway (Easy DKIM records shown).
- Adapters: `adapters/ses/ses.ts` (SESv2 client; LIVE and SANDBOX; credentials sealed on the account, else the
  environment's), `fake.ts` (FAKE: in-memory mailbox, local and test only; never a table or a file), `sns.ts` (the SNS
  envelope parser and verifier), `testing.ts` (FakeSesTransport: the real client on a scripted transport;
  sesNotificationBody). Tests: `email.pg.vitest.test.ts` on the auth harness (`h.ses`, `h.email`, `h.files`, `h.mailer`).

## Email in (`src/platform/email-in/`, `src/adapters/ses-inbound/`, plan A1 §3.7; COL-020, COL-022, COL-023, COL-025, COL-026)
- Table (email-in.prisma): InboundEmail, office only: what SES said (account, receipt, SES id, S3 bucket and key, envelope,
  SPF/DKIM/DMARC/spam/virus verdicts; never changes), what the mail held (From, To, Cc, subject, Message-ID unique per
  tenant, In-Reply-To, References, size, text, sanitised HTML; written once, when read), its attachments (JSON: kept ones
  with their object and file, skipped ones with why), status RECEIVED → FETCHED → MATCHED | TRIAGE | HELD | REJECTED, or
  FAILED; thread, message, matchedBy (TOKEN, HEADERS, SENDER, MANUAL), held and reject reasons, the sender's party and
  contact (a suggestion while it waits). The …_email_in_guards trigger holds all of it; nothing is deleted.
- Receive (`receive.ts`, inside the inbound ledger's processing command): SES's "Received" notification → ONE row
  RECEIVED + `email.inbound_received` (a virus verdict: REJECTED, never read); the same SES id or Message-ID again adds
  nothing. Other SES notifications go on to email out's processor (`emailInProcessor(next)`, inbound/providers.ts).
- Fetch (`fetch.ts`, worker handler `emailIn.fetch`): the raw mail through the gateway (`mail.fetch_inbound` on the SES
  account: FAKE → `adapters/ses-inbound/fake.ts` FakeMailBucket, in memory; LIVE/SANDBOX → `s3.ts`, GetObject from the
  account's `settings.inboundBucket` only; at most 40 MB) → postal-mime (`parse.ts`) → sanitised HTML and text
  (factory-domain email-in/sanitise) → each attachment an ATTACHMENT file may hold is put in the file store (files.put);
  inline pictures, other types, empty and too many are listed as skipped → command FETCHED + `email.inbound_fetched`.
  A retryable failure is counted and retried (5 tries), a final one (object gone or too large, unreadable, no file store)
  makes the mail FAILED.
- Sort (`sort.ts`, handler `emailIn.sort`, ONE command): the facts (`match.ts`: thread by `r-<token>@<a tenant reply
  domain>`, else In-Reply-To/References against OUTBOUND Message-IDs; the sender known to the thread: a contact of its
  party, a recipient of its mail, or at a contact's company domain; else the one party the sender is a contact of and
  its `Party` thread) → factory-domain `sortMail`: virus or duplicate Message-ID → REJECTED; DMARC FAIL or spam → HELD;
  thread + unknown sender → HELD; closed thread → HELD; thread without party → TRIAGE; else MATCHED: `writeMessage`
  INBOUND EMAIL (sanitised HTML, the mail's Message-ID) with the files on the thread's RECORD shared with its party; a
  known contact without a thread joins its party's thread only with DMARC PASS and a `Party` thread resolver (the parties
  module's; none in W0: TRIAGE with the party suggested). HELD and TRIAGE keep their files on the mail (office only).
  Event `email.inbound_sorted` (live: email.triage).
- "Mail to sort" (A2 SCR-019; email.triage over the mail's company; `triage.ts`): `GET /email/inbound` (TRIAGE, HELD,
  FAILED, or `?status=`), `GET /email/inbound/:id`, `POST …/:id/assign` (record with a party; threads.post over it),
  `POST …/:id/release` (HELD: into the thread it named, also a closed one, else TRIAGE), `POST …/:id/reject`
  (MARKED_SPAM | DISCARDED). Version-guarded commands; assign and release copy the mail's files onto the record (files.read
  + files.put before the command: a file's record never changes). Answers never hold the raw mail, its S3 place, a reply
  token or a storage key.
- Tests: `email-in.pg.vitest.test.ts` on the auth harness (`createEmailInRuntime({ gateway, fake: FakeMailBucket, s3 })`,
  `testing.ts`: `receivedNotificationBody`, `rawMail`), `parse.vitest.test.ts`, `adapters/ses-inbound` (FakeS3Transport).

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
