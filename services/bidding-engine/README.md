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

## Primary-app endpoints to implement (contract)
```
GET  /internal/bidding/contexts?marketplace=&limit=
       -> { contexts: BidContext[] }       # joins AdTarget bids + Product days-of-supply + strategy ACoS
POST /internal/bidding/applied
       { bridgeId, externalId, bidMinor, prevBidMinor, status }   # updates the local row + AdvertisingActionLog
```
Both require `x-internal-token: <PRIMARY_API_TOKEN>`. These are the only coupling
points; everything else is self-contained here.

## Deploy (Railway, separate service)
- Root directory: `services/bidding-engine`
- Build: `npm install && npm run build` · Start: `npm start`
- Vars: `REDIS_URL` (shared), `PRIMARY_API_URL`, `PRIMARY_API_TOKEN`, Amazon LWA
  creds, `BIDDING_DRY_RUN`. Scale horizontally — the token bucket + dedupe job
  ids keep multiple replicas safe.
