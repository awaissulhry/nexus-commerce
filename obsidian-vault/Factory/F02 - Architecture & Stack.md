# F02 - Architecture & Stack

> Canonical: `docs/factory/F0-ARCHITECTURE.md` + PLAYBOOK §4-5, §9-10. This note is the vault summary.

Hub: [[F00 - Factory OS MOC]] · substrate: [[F22 - Substrate FS Series]]

## Runtime

1. **One Next.js 16 App Router app** (`apps/factory`, RSC UI + API route handlers, single process, **port 3100**) — single origin kills the CORS/cookie/SSR-anonymous-fetch class.
2. **Sidecar worker** (`apps/factory/worker/`, plain Node via tsx) — Gmail poll 10s, tracking poll 15-30 min, snooze/reminders, nightly `VACUUM INTO` backup (rotate 14). Separate crash domain; events cross process boundaries only via the durable `FactoryEventOutbox`.
3. **Prisma 7.8.0 pinned** + `@prisma/adapter-better-sqlite3` + **SQLite WAL** (`busy_timeout=5000`, `synchronous=NORMAL`); zod at boundaries (enums/Json runtime-enforced). Fully isolated from the commerce Postgres/Neon DB.
4. **SSE real-time** — post-FS2: ONE shared outbox poller per web process (1 query/s flat in client count), id-based gap-free resume, targeted delivery. Hook: `useFactoryEvents`.
5. **Auth** — server-side sessions, CSRF double-submit, RBAC `guarded()` on every route + name-based money field-strip (`*Cents`) — see [[F04 - Domain Model & Money Invariants]].

## Integrations

- **Gmail** — Desktop OAuth client, consent screen published-to-Production (Testing = 7-day token death, FD10); label-scoped sync + `history.list`; threading needs threadId + In-Reply-To/References + Subject together.
- **Drive** — `drive.file` scope, per-party folders under "Nexus Factory", lazily created, ids cached.
- **Sendcloud** — `CarrierAdapter` interface with FakeCarrier for $0 verification; real adapter on connect (FD6).
- **Stripe** — env-gated on keys, quotes acceptance page only ([[F11 - Quotes (EPQ)]] D-1), bank-transfer fallback always on.

## Verification discipline (PLAYBOOK §10 — learned the hard way)

The Owner's dev server runs on `:3100` with `.next-dev`; sessions verify on **`:3199`** with `FACTORY_BUILD_DIR=.next-verify` — never bind 3100. Headless UI checks via apps/web's Playwright (`createRequire` trick), programmatic login. No automated live sends or label purchases, ever. After any migration, the Owner's dev server must restart (cached Prisma client writes to new columns → 500).

## Key traps (full list PLAYBOOK §13)

Concurrent sessions on main (scoped commits; push races benign) · shell cwd drifts (always `cd` explicitly) · empty-string env vars (`||` never `??`) · Prisma 7 datasource in `prisma.config.ts` · React 18.3.1 EXACT pins vs root's 19 · worker events invisible without the outbox · macOS has no `timeout` · sanitize-html at ingest, sandboxed iframe at render.
