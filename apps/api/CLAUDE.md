# apps/api

Fastify 5 API; `tsconfig` is not strict. On `main` this process also starts every BullMQ worker and cron
(`src/index.ts`), unless `NEXUS_DISABLE_BACKGROUND_JOBS=1` is set. Import the database client as
`import prisma from '../db.js'`; `db.ts` loads `env.ts` first.

## Routes
- One Fastify plugin per `src/routes/*.routes.ts`, registered in `src/index.ts` with `app.register(x, { prefix: '/api' })`.
- Exemplar: `src/routes/connection-dependents.routes.ts` → `src/services/connection-dependents.service.ts`. The
  route parses input, calls a service and maps errors to status codes.
- A new route file holds zero Prisma calls; logic goes in `src/services/` (`scripts/check-route-prisma-ratchet.mjs`).
- Every route needs a rule in `src/lib/auth/permissions-manifest.ts` (first match wins; unmapped means denied).
  Check with `npx tsx src/scripts/check-rbac-coverage.ts`; it boots the app, so it needs `DATABASE_URL` and `REDIS_URL`.
- Advertising-owned models are private to the advertising context (`scripts/check-context-boundary.mjs`). Stock
  writers take the stock lock (`scripts/check-stock-writer-lock.mjs`).

## GraphQL (Mercurius) vs REST
- `/graphql` (`src/graph/`) serves reads of products, inventory and listings only. Never add a `Mutation` type:
  every write is REST, so each write has one path and one set of guards (`src/graph/schema.ts`).
- A new GraphQL field needs a `FIELD_AUTH` entry in `src/graph/auth.ts` (`scripts/check-graph-contract.mjs`).
- Everything else is REST.

## Marketplace calls — always through the gateway
- Never `fetch` Amazon (SP-API or Ads), eBay, Etsy or Shopify directly.
- Use `gatewayFetch` / `gatewayCall` (`src/services/gateway/gateway.ts`) or their channel wrappers in
  `src/services/gateway/` (`ebay.ts`, `shopify.ts`, `ads.ts`, `amazon-sdk.ts`). Exemplar: `src/services/etsy/read-client.ts`.
- The gateway checks account state, publish mode, push lock, rate bucket and idempotency, and logs one
  `OutboundApiCallLog` row per call. `cd apps/api && npx tsx scripts/channel-gateway-ratchet.mts --check` holds
  direct calls at 0 per channel.
- A genuine exception (OAuth token exchange, pre-signed upload URL) carries `// gateway-exempt: <reason>`.

## Webhooks — verify, store, then process asynchronously
1. Verify the provider signature before anything else.
2. Store the event with `recordInbound` (`src/services/cx/ingress/ledger.ts`) in `WebhookEvent`.
3. Process it asynchronously, never inline in the request. `src/jobs/inbound-retry.job.ts` drains pending events.
- Every stored event type needs a replay handler in `src/services/cx/ingress/handlers.ts`. Never delete a
  `WebhookEvent` (`scripts/check-inbound-ledger.mjs`).

## Jobs and crons
- Crons: `import cron from '../lib/cron/clustered.js'`, then `cron.schedule(expr, fn)`. It takes a per-minute Redis
  lock per job. With business profiles on, it runs once per active workspace. Importing `node-cron` directly fails
  `scripts/check-cron-clustered.mjs`.
- Queues: `Queue` from `src/lib/queue.ts` (that is `WorkspaceQueue`) and `WorkspaceWorker` from
  `src/lib/workspace-jobs.ts`. They carry the workspace in the job data. Exemplar: `src/workers/read-cache.worker.ts`.
- Every job and cron handler must be idempotent: jobs retry, and a cron lock can fail open. Dedupe with a
  deterministic `jobId` (e.g. `cache:refresh:<id>`). Use `addJobSafely` only when a PENDING row plus a drain cron
  back the job.
- Workers run only with `ENABLE_QUEUE_WORKERS=1` and Redis (`REDIS_URL`).
- Code outside a request needs a workspace context: `visitActiveWorkspaces` (`src/lib/workspace-sweep.ts`) or
  `runProfileTimer` (`src/lib/cron/workspace-timer.ts`).

## Secrets
- Store credentials with `encryptCredentials` / `decryptCredentials` (`src/lib/crypto.ts`). That is AWS KMS envelope
  encryption keyed by `NEXUS_KMS_KEY_ID`.
- Don't use `encryptSecret` (a local env key only) in new code, and never add a plaintext secret column.
- Log with `logger` from `src/utils/logger.ts`, which redacts token, secret, password and key fields.
  `request.log` and `app.log` do not redact: never pass them credentials, tokens or request bodies.

## OpenTelemetry
- Off unless `NEXUS_OTEL_ENABLED=1` and `OTEL_EXPORTER_OTLP_ENDPOINT` are set. There is no HTTP or Prisma
  auto-instrumentation.
- Wrap work in `withSpan(name, attributes, fn)` from `src/utils/otel-setup.ts`.
- Name spans `<area>.<operation>` in lower case, as `gatewayCall` does (`<channel>.<operation>`).
- Reuse the existing attribute keys: `channel`, `operation`, `marketplace`, `http.method`, `http.endpoint`,
  `product.id`, `listing.id`, `order.id`.
- Never put tokens, bodies or customer data in a span.
