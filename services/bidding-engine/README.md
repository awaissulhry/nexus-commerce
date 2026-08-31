# @nexus/bidding-engine

High-performance **Hybrid Bidding Engine** microservice (v2 blueprint, Module 2).
Isolated from the primary Fastify app — it owns the bid queue, the
inventory-elasticity math, per-profile rate limiting, and the Amazon writes.
It reaches the primary database **only** through the primary app's internal REST.

> Lives in `services/` (not `apps/`) on purpose: it is **outside the npm
> workspace glob** (`apps/*`, `packages/*`), so it has its own dependency graph
> and deploys as a separate Railway service without touching `apps/api` /
> `apps/web` installs or the shared pre-push build gate.

## Architecture
```
primary app (Fastify+Prisma)            bidding-engine (this service)
  GET  /internal/bidding/contexts  ◄── producer.optimizeFromPrimary()
  POST /internal/bidding/applied   ◄── worker → reportApplied()
                                          │
                          BullMQ ◄── producer (computeBid + 2% deadband + dedupe)
                                          │
                          worker → TokenBucket(per profile) → Amazon Ads v3 PUT
                                          └─ 429 → moveToDelayed(Retry-After) + backoff
```

- **`bidding.ts`** — pure formula: `CR_blend → Bid_base → θ_inv (inventory) → θ_intra (hourly) → clamp`. Unit-tested (`bidding.test.ts`).
- **`rate-limiter.ts`** — distributed token bucket (atomic Redis Lua), per Amazon profile, correct across replicas.
- **`amazon-client.ts`** — LWA token cache + v3 SP keyword-bid PUT; 429 → typed `ThrottleError(retryAfterMs)`.
- **`worker.ts`** — rate gate → write → 429 backoff → ack; exhausted jobs report `failed` so the primary clears its optimistic row.
- **`producer.ts` / `http.ts` / `index.ts`** — enqueue, control surface (`/health`, `/ready`, `/metrics`, `POST /optimize`), bootstrap + graceful drain.

## Run
```bash
cp .env.example .env     # set REDIS_URL, PRIMARY_API_URL/TOKEN, Amazon creds; keep BIDDING_DRY_RUN=1
npm install
npm run dev              # tsx watch
npm test                 # bidding math
```
Starts `BIDDING_DRY_RUN=1` (computes + logs, never writes). Flip to `0` only
after the primary write-gate cutover. `npm run build && npm start` for prod.

## Primary-app endpoints (contract) — BUILT and verified

```
GET  /api/internal/bidding/contexts?marketplace=&limit=
       -> { contexts: BidContext[] }       # joins AdTarget bids + Product days-of-supply + strategy ACoS
POST /api/internal/bidding/applied
       { bridgeId, externalId, bidMinor, prevBidMinor, status }   # updates the local row + AdvertisingActionLog
```

Both exist in `apps/api/src/routes/advertising.routes.ts` and were exercised end
to end locally (PH.4c): contexts fetched, bid computed, result reported, and an
`AdvertisingActionLog` row written — two processes, no shared database.

🔴 **The `/api` prefix is load-bearing.** `advertisingRoutes` is registered with
`{ prefix: '/api' }`, so the endpoints live under `/api`, and the permissions
manifest maps `/api/internal/bidding` to `ads.automation.manage`. This README and
`primary-client.ts` both omitted it; the unprefixed path returns **404**, which
would have surfaced on the first deploy. `PRIMARY_API_URL` stays the bare origin
(no `/api`) — the client adds the prefix.

🔴 **The shared secret has two names.** The engine sends `PRIMARY_API_TOKEN` as
the `x-internal-token` header; the primary compares it against
`NEXUS_INTERNAL_API_TOKEN`. Same value, different variable on each side — a
mismatch is a silent 401, not an error anyone will notice.

A response body carries `accountRef` (the Amazon advertising profile id), not
`profileId`.

## Deploy (Railway, separate service) — READY, NOT DEPLOYED

Everything this needs was verified on production 2026-09-01. It is deliberately
undeployed: nothing measured requires it (the API averages 0.078 vCPU), so it
waits for a reason rather than an acronym. When there is one, this is the whole
procedure.

**Prerequisites — all confirmed live:**
- `/api/internal/bidding/contexts` returns **200** with `x-internal-token`, **401**
  without. Measured against production. It returned 401 to *everything* until
  2026-09-01 — see below.
- `NEXUS_INTERNAL_API_TOKEN` is set on the `@nexus/api` Railway service.
- The client's paths carry the `/api` prefix (fixed; the unprefixed path 404s).

**Step 1 — create the service, scheduler OFF.**
- Root directory: `services/bidding-engine` (outside the npm workspace glob, so
  it has its own dependency graph and does not touch apps/* installs)
- Build `npm install && npm run build` · Start `npm start`
- Vars:
  - `REDIS_URL` = `${{Redis.REDIS_URL}}` — **by reference, not by value.** The
    rate limiter is a distributed token bucket and is only correct if every
    writer shares one Redis.
  - `PRIMARY_API_URL` = the API's **bare origin**, no `/api` — the client adds
    `/api/internal/bidding` itself.
  - `PRIMARY_API_TOKEN` = the value of the primary's `NEXUS_INTERNAL_API_TOKEN`.
    Same secret, different variable name on each side; a mismatch is a silent 401.
  - `BIDDING_DRY_RUN=1`
  - `BIDDING_INTERVAL_MIN=0` — scheduler disabled for now.
  - **Set NO Amazon credentials.** Two independent reasons nothing reaches
    Amazon: the dry-run flag, and nothing to authenticate with.
- Confirm `/health` and `/ready`.

**Step 2 — one deliberate cycle.** `POST /optimize` by hand. Exercises the whole
chain once: contexts → compute → `/applied` → an `AdvertisingActionLog` row on
the primary, with `status: 'dry-run'` and the live bid untouched. Watch it once
before anything runs on a timer.

**Step 3 — enable the timer** (`BIDDING_INTERVAL_MIN=60`) only after step 2 is
clean. Scale horizontally after that: the token bucket and dedupe job ids make
multiple replicas safe.

**Going live to Amazon is a separate, later decision** — add the LWA credentials
and `AMAZON_ADS_REFRESH_TOKEN`, then flip `BIDDING_DRY_RUN=0`. Do not combine it
with the deploy.

### Why the contract was dead until 2026-09-01
`/api/internal/bidding` was mapped to `ads.automation.manage` in the permissions
manifest, so `rbacHook` denied every call **401 before `internalAuthed` ever
ran** — a service caller has no session, so a session check could never be the
right gate. It is now `PUBLIC` at the RBAC layer with the shared secret as the
real gate, matching the webhook receivers. This is the AMS.1 bug, which cost
35,614 silent rejections in 24h the first time it happened.
