# eBay Outbound Sync — Root-Cause Fix + Failure Isolation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make eBay outbound quantity/price sync actually succeed (it is currently 0-for-4,120 over 30 days), and make sure a single bad listing or a masked error can never silently take down the whole eBay channel again.

**Architecture:** Three surgical changes to the existing outbound-sync path plus the eBay circuit breaker. No schema changes. No new services. Mirror the already-proven eBay flat-file push for the header fix.

**Tech Stack:** Fastify + Prisma + BullMQ (apps/api). eBay Sell Inventory API v1.

## Background — confirmed diagnosis (2026-07-01)

- **Every** eBay outbound failure is the eBay Inventory API rejecting our `inventory_item` PUT with:
  `400 errorId 25709 — "Invalid value for header Accept-Language."`
- 30-day eBay rollup: **4,120 attempts, 0 succeeded, 83 real `failed`, 3,986 `circuit-open`, 51 gated.** eBay push has never once succeeded.
- Root cause: `outbound-sync.service.ts` sends the eBay PUTs with `Content-Language: "en-US"` hardcoded and **omits `Accept-Language` and `X-EBAY-C-MARKETPLACE-ID`**. eBay's Inventory API requires both language headers, set to the marketplace locale (`it-IT` for `EBAY_IT`), on every call. The **working** flat-file push (`ebay-flat-file.routes.ts`) already does this (explicit comment there: "Both Content-Language AND Accept-Language required on every Inventory API call.").
- Secondary problems that let this hide for 30 days:
  1. The **queue row / Control Tower only ever showed "circuit open"**, never the real `25709` error — the true error is only in the `ChannelPublishAttempt` audit log.
  2. The eBay **circuit breaker is per-(connection, marketplace)** — one repeatedly-failing listing (all failures are the single product GALE-JACKET, currently the only eBay-listed product) trips the circuit for the **entire** eBay marketplace, so even healthy listings get blocked. A per-listing 400 validation error should never back off the whole channel.

## Global Constraints

- **Do NOT weaken the FBA fail-closed guard** (`isFbaListing` / FBA never clamped/overwritten). Untouched by this plan.
- **Zero changes** to `/products/amazon-flat-file`, `/products/ebay-flat-file` pages/routes (`ebay-flat-file.routes.ts` is READ-ONLY reference here — do not edit it).
- Mirror the **existing** working header setup; do not invent a new locale scheme. Reuse `toListingLanguage` (exported from `ebay-variation-push.service.ts`).
- eBay marketplace id in outbound-sync is already `EBAY_IT`-form (`payload.marketplaceId ?? "EBAY_IT"`). 2-letter market = `marketplaceId.replace(/^EBAY_/, "")`.
- No Prisma migration. `OutboundSyncQueue.errorMessage`, `errorCode`, `isDead` columns already exist.
- Verify on prod (Railway) after deploy — no local Docker DB. Local is for `tsc`/tests only.
- Behaviour flags default ON (user preference: ship live, not dark), with a documented kill-switch env for each behavioural change.

---

### Task 1: Fix the eBay Inventory API language headers (root cause)

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (the `syncToEbay` method, section 7 — the `headers` object at ~959 and the two PUT calls at ~1004 and ~1030)
- Test: `apps/api/src/services/outbound-sync.ebay-headers.vitest.test.ts` (new)

**Interfaces:**
- Consumes: `toListingLanguage(mp: string): string` — import from `./ebay-variation-push.service.js` (returns `it-IT`/`de-DE`/… , defaults `en-US`).
- Produces: no new exports; internal header correctness only.

- [ ] **Step 1: Write the failing test.** Extract the header-building into a tiny pure helper so it is unit-testable, then assert it. In `outbound-sync.service.ts` add near the top-level helpers:

```ts
/** eBay Inventory API requires BOTH language headers set to the marketplace
 *  locale, plus the marketplace id, on every call (error 25709 otherwise). */
export function ebayInventoryHeaders(token: string, marketplaceId: string): Record<string, string> {
  const mp2 = (marketplaceId ?? "EBAY_IT").replace(/^EBAY_/, "");
  const lang = toListingLanguage(mp2);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Content-Language": lang,
    "Accept-Language": lang,
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId ?? "EBAY_IT",
  };
}
```

Test:

```ts
import { describe, it, expect } from 'vitest'
import { ebayInventoryHeaders } from './outbound-sync.service.js'

describe('ebayInventoryHeaders', () => {
  it('sets it-IT for EBAY_IT and includes both language headers + marketplace id', () => {
    const h = ebayInventoryHeaders('TOK', 'EBAY_IT')
    expect(h['Content-Language']).toBe('it-IT')
    expect(h['Accept-Language']).toBe('it-IT')
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_IT')
    expect(h.Authorization).toBe('Bearer TOK')
  })
  it('maps EBAY_DE -> de-DE and EBAY_GB -> en-GB', () => {
    expect(ebayInventoryHeaders('T', 'EBAY_DE')['Accept-Language']).toBe('de-DE')
    expect(ebayInventoryHeaders('T', 'EBAY_GB')['Accept-Language']).toBe('en-GB')
  })
  it('defaults marketplace + locale when marketplaceId missing', () => {
    const h = ebayInventoryHeaders('T', undefined as any)
    expect(h['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_IT')
    expect(h['Accept-Language']).toBe('it-IT')
  })
})
```

- [ ] **Step 2: Run it, verify it fails** (`ebayInventoryHeaders` not yet exported): `npx vitest run apps/api/src/services/outbound-sync.ebay-headers.vitest.test.ts`
- [ ] **Step 3: Implement.** Add the `ebayInventoryHeaders` helper (above). Add `import { toListingLanguage } from './ebay-variation-push.service.js'` if not already imported. In `syncToEbay`, replace the section-7 `const headers = { Authorization, "Content-Type", Accept }` with `const headers = ebayInventoryHeaders(token, marketplaceId)`. Remove the two ad-hoc `"Content-Language": "en-US"` spreads on the PUTs (lines ~1006 and ~1034) — the base `headers` now already carries the correct language headers, so the PUTs become `headers` (or `{ ...headers }`). Confirm the GET at ~1002, the inventory_item PUT at ~1004, the offer GET at ~1016, and the offer PUT at ~1030 all use this `headers`.
- [ ] **Step 4: Run tests, verify pass.** `npx vitest run apps/api/src/services/outbound-sync.ebay-headers.vitest.test.ts` and the existing `apps/api/src/services/listing-publish.vitest.test.ts` + `outbound-sync.shared-trading.vitest.test.ts` (must stay green). `npx tsc --noEmit` in apps/api.
- [ ] **Step 5: Commit.** `fix(ebay-sync): send it-IT Content/Accept-Language + marketplace-id on Inventory PUT (eBay 25709)`

---

### Task 2: Surface the real eBay error on the queue row (never mask with "circuit open" again)

**Why:** This bug hid for 4,120 attempts because the Control Tower/queue row only showed the downstream "circuit open" message; the real 25709 lived only in the audit log. Persist the real API error onto the row so the operator sees the true cause.

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (the `ebayFail` closure in `syncToEbay`, and the `fail("circuit-open", …)` return)
- Test: `apps/api/src/services/outbound-sync.ebay-error-surface.vitest.test.ts` (new)

**Interfaces:**
- Consumes: existing `SyncResult` shape (`{ success, status, error, ... }`) and the BullMQ worker's per-job status write that copies `result.error` → `OutboundSyncQueue.errorMessage`.
- Produces: `SyncResult.errorCode` populated with a stable classifier for eBay failures (`EBAY_VALIDATION` | `EBAY_TRANSIENT` | `EBAY_CIRCUIT_OPEN`).

- [ ] **Step 1: Write failing test** — assert `syncToEbay`-style failure classification. Extract a pure classifier:

```ts
export function classifyEbayFailure(httpStatus: number | null): {
  code: 'EBAY_VALIDATION' | 'EBAY_TRANSIENT'
  retryable: boolean
  tripsCircuit: boolean
} {
  // 400/404/409/422 = the listing/payload is wrong; retrying won't help and it
  // must NOT back off the whole marketplace. Everything else (401/403/429/5xx,
  // network/null) is transient/connection-level: retry + trip the circuit.
  const listingFatal = httpStatus != null && [400, 404, 409, 422].includes(httpStatus)
  return listingFatal
    ? { code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false }
    : { code: 'EBAY_TRANSIENT', retryable: true, tripsCircuit: true }
}
```

```ts
import { classifyEbayFailure } from './outbound-sync.service.js'
it('400 validation is listing-fatal, non-retryable, does not trip circuit', () => {
  expect(classifyEbayFailure(400)).toEqual({ code: 'EBAY_VALIDATION', retryable: false, tripsCircuit: false })
})
it('429 / 500 / null are transient and trip the circuit', () => {
  for (const s of [429, 500, 503, null]) expect(classifyEbayFailure(s as any).tripsCircuit).toBe(true)
})
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Add `classifyEbayFailure`. Thread the HTTP status out of the `inventory_item` / `offer` PUT branches (they already have `putRes.status` / `offerRes.status`) into `ebayFail(message, outcome, httpStatus?)`. In `ebayFail`, set the returned `SyncResult.error` to the FULL real message (already does) and add `errorCode = classifyEbayFailure(httpStatus).code`. Keep writing the attempt log. The BullMQ worker already copies `result.error` → row `errorMessage`; confirm it also copies `result.errorCode` → row `errorCode` (add if missing — one line in the worker's failure branch).
- [ ] **Step 4: Run tests + tsc.**
- [ ] **Step 5: Commit.** `fix(ebay-sync): persist real eBay API error + classifier onto queue row (stop masking with circuit-open)`

---

### Task 3: Failure isolation — a per-listing validation error must not trip the whole-marketplace circuit

**Why:** The circuit breaker exists to back off when eBay/the connection is unhealthy. A `400` validation error on one listing means THAT listing is broken, not the channel. Today it counts toward the marketplace circuit and (after 3) blocks every listing.

**Files:**
- Modify: `apps/api/src/services/outbound-sync.service.ts` (`syncToEbay` failure branches — call `recordEbayOutcome(..., false)` only when `tripsCircuit`; for `EBAY_VALIDATION` mark the row dead instead)
- Modify: `apps/api/src/services/ebay-publish-gate.service.ts` only if a helper is needed (prefer NOT to change the breaker itself)
- Test: `apps/api/src/services/outbound-sync.ebay-isolation.vitest.test.ts` (new)

**Interfaces:**
- Consumes: `recordEbayOutcome(connectionId, marketplaceId, success)` (existing), `classifyEbayFailure` (Task 2).
- Produces: on `EBAY_VALIDATION`, `SyncResult.status = 'FAILED'` with `isDead`-intent so the worker sets `isDead = true` (stops the retry/flood) and does NOT call `recordEbayOutcome(false)`.

- [ ] **Step 1: Write failing test.** Given a 400 validation failure, assert the code path does NOT record a circuit failure and marks the outcome non-retryable; given a 500, assert it DOES record toward the circuit and stays retryable. (Mock `recordEbayOutcome`; assert call/no-call — this mirrors the existing mock style in `listing-publish.vitest.test.ts`.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** In each eBay PUT failure branch: compute `const c = classifyEbayFailure(status)`. Only `if (c.tripsCircuit) recordEbayOutcome(connection.id, marketplaceId, false)`. Return `ebayFail(message, 'failed', status)`; when `!c.retryable`, include a flag so the worker marks the row `isDead = true` + `nextRetryAt = null` (so the poison listing stops flooding retries and shows as a clear DEAD row in the Control Tower). Kill-switch: `NEXUS_EBAY_FAILURE_ISOLATION` (default `'1'`); when `'0'`, preserve today's behaviour (always record + retry).
- [ ] **Step 4: Run tests + tsc + full `apps/api` vitest for the eBay/outbound files.**
- [ ] **Step 5: Commit.** `feat(ebay-sync): isolate per-listing validation failures from the marketplace circuit breaker`

---

### Task 4: Post-deploy verification + cleanup (run against prod after Railway redeploys)

Not a code task — a verification runbook, executed by the controller after Tasks 1-3 ship and Railway redeploys.

- [ ] Reset the eBay circuit: `POST /api/dashboard/circuit-breakers/EBAY/reset`.
- [ ] Bulk-retry ONE GALE-JACKET eBay row; poll `/api/listings/publish-status` `recentFailures` — confirm the outcome is now `success` (not a 25709 `failed`).
- [ ] If green, bulk-retry the rest (`POST /api/outbound-queue/bulk-retry {channel:"EBAY"}`); confirm the 311 rows drain to SUCCESS and the Control Tower GALE-JACKET family goes green.
- [ ] Confirm 30-day rollup `succeeded` count begins climbing from 0.
- [ ] The 311 stale rows clear naturally on success (honours the user's "clean it up" without masking an unfixed problem). If any remain FAILED with a NEW real error, surface it (Task 2 now makes it visible) and triage.

---

## Self-review

- **Spec coverage:** header fix (Task 1) = the 25709 root cause; error surfacing (Task 2) = the observability gap that hid it; isolation (Task 3) = the marketplace-wide-circuit design gap; verification (Task 4) = prove it on prod + clean up. All four confirmed problems covered.
- **No placeholders:** exact files, line anchors, real code, real commands.
- **Type consistency:** `ebayInventoryHeaders` / `classifyEbayFailure` names used identically across tasks. `toListingLanguage` import path matches the existing export.
- **FBA guard / flat-file untouchable:** neither touched; flat-file is read-only reference.
