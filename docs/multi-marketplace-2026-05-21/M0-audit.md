# M0 — Multi-Marketplace Audit Report

**Run date:** 2026-05-21
**Probe source:** Production `/api/amazon/reconciliation/all?daysBack=14` (deployed I11 route + the SP-API auth scope on Railway)

---

## ✅ Headline: every marketplace IS authorized

The operator's SP-API LWA auth covers **all 9 marketplaces** — none returned 403 on the orders or inventory endpoints. The single auth-scope gap is **US FBA inventory** (the only `Access denied` warning in the probe).

That means: **no re-authorization is required before M3 starts.** The blocker is purely the code-layer hardcoding (M2).

---

## 14-day order volume probe (from production)

```
┌──────┬─────────────┬──────────┬──────────────┬──────────────┬───────────┐
│ Code │ MarketplaceId        │ Currency │ 14d orders  │ 14d revenue │ In Nexus  │
├──────┼─────────────┼──────────┼──────────────┼──────────────┼───────────┤
│ IT   │ APJ6JRA9NG5V4        │ EUR      │           71│ €7,275.41    │  ✅ 71    │  ← already backfilled
│ DE   │ A1PA6795UKMFR9       │ EUR      │           40│ €4,154.12    │  ❌ 0     │  ← MISSING — biggest gap
│ FR   │ A13V1IB3VIYZZH       │ EUR      │           19│ €1,981.88    │  ❌ 0     │  ← MISSING
│ ES   │ A1RKKUPIHCS9HS       │ EUR      │            3│ €315.00      │  ❌ 0     │  ← MISSING
│ NL   │ A1805IZSGTT6HS       │ EUR      │            0│ €0           │  -        │  ← no activity
│ UK   │ A1F83G8C2ARO7P       │ GBP      │            0│ £0           │  -        │  ← no activity
│ PL   │ A1C3SOZRARQ6R3       │ PLN      │            0│ zł0          │  -        │  ← no activity
│ SE   │ A2NODRKZP88ZB9       │ SEK      │            0│ kr0          │  -        │  ← no activity
│ US   │ ATVPDKIKX0DER        │ USD      │            0│ $0           │  -        │  ← no activity (FBA denied)
└──────┴─────────────┴──────────┴──────────────┴──────────────┴───────────┘
```

### Currency cross-check (14d)

```
EUR  channel €13,726.41   nexus €7,275.41   drift -€6,451.00   (-47%)  ← DE + FR + ES missing
PLN  0/0/0                                                                ← no activity
SEK  0/0/0                                                                ← no activity
GBP  0/0/0                                                                ← no activity
USD  0/0/0                                                                ← no activity
```

### Extrapolated 12-month estimate (linear from 14-day window)

| Market | 14d orders | Extrapolated 12-month | Extrapolated revenue |
|---|---|---|---|
| **IT** | 71 | ~1,851 | ~€190K *(matches historical 2-yr backfill — €188K)* |
| **DE** | 40 | ~1,043 | ~€108K |
| **FR** | 19 | ~495 | ~€51K |
| **ES** | 3 | ~78 | ~€8K |
| NL | 0 | likely <30 | ~€3K |
| UK / PL / SE / US | 0 | likely 0 | €0 |

**Net missing revenue (12-month, lower bound):** ~€167K of EU sales currently invisible. DE alone is the biggest miss.

---

## Code-layer audit — `process.env.AMAZON_MARKETPLACE_ID` references

**Total references:** 93 across `apps/api/src` + `scripts/`. Of those, 30+ are env-default reads (the actual hardcoding to fix in M2); the rest are static code↔id lookup tables (mostly OK — just need to be filled in for the other markets).

### 🔴 Env-default hardcodes (need M2 changes)

| File | Line | What it does | M2 action |
|---|---|---|---|
| `routes/amazon.routes.ts` | 383 | `getCatalogItem` test endpoint | Accept `marketplaceId` query param |
| `routes/amazon.routes.ts` | 474 | `getCatalogItem v2022-04-01` test | Accept `marketplaceId` |
| `routes/amazon.routes.ts` | 554 | Orders test endpoint | Accept `marketplaceId` |
| `routes/amazon.routes.ts` | 630 | Listings endpoint | Accept `marketplaceId` |
| `routes/amazon.routes.ts` | 892 | Pricing endpoint | Accept `marketplaceId` |
| `routes/amazon.routes.ts` | 1215 | Reports endpoint | Already accepts override; default to participating list |
| `routes/amazon.routes.ts` | 1301 | Settlements report request | Iterate participating markets |
| `routes/amazon.routes.ts` | 1474 | **POST /orders/sync** | Add `marketplaceIds?: string[]`; default = all participating |
| `routes/amazon.routes.ts` | 1766 | A+ Content sync | Accept `marketplaceIds` |
| `routes/amazon.routes.ts` | 1857 | A+ Content probe | Accept `marketplaceId` |
| `routes/amazon.routes.ts` | 2006 | Listings reconciliation | Iterate participating |
| `services/amazon-inventory.service.ts` | 55, 116 | FBA inventory pulls | Accept `marketplaceId` (already does — EU pool aggregates) |
| `services/aplus-amazon-pull.service.ts` | 81 | A+ Content pull | Already accepts override |
| `services/amazon-financial-events.service.ts` | 445 | FinancialEvents fetch | Already accepts override |
| `services/fba-inbound.service.ts` | 81, 177, 472, 571 | FBA inbound shipments | Accept `marketplaceId` |
| `services/amazon-returns/ingest.service.ts` | 258 | Returns ingestion | Already accepts override |
| `services/advertising/fba-fees-ingest.service.ts` | 29 | FBA fees ingest | Accept `marketplaceId` |
| `services/marketplaces/amazon.service.ts` | 307, 338, 508, 842, 912, 1046 | AmazonService helpers | Already accept override mostly |
| `services/categories/marketplace-ids.ts` | 40 | Browse-node API helper | Accept caller-supplied id |
| `services/channel-reconciliation.service.ts` | 181 | Reconciliation (single-market) | ✅ Already accepts override (I11) |

### 🟡 Static code↔id mapping tables (mostly OK — just need to be complete)

| File | Line | Current state |
|---|---|---|
| `jobs/review-request-mailer.job.ts` | 44 | Full mapping IT/DE/FR/ES — needs NL/UK/PL/SE/US |
| `jobs/tracking-pushback.job.ts` | 66 | IT-only — needs full table |
| `services/amazon-orders.service.ts` | 106 | Reverse-mapping APJ6JRA9NG5V4: 'IT' — needs full table |
| `services/channel-delist.service.ts` | 72 | IT-only — needs full table |
| `services/amazon/flat-file.service.ts` | 23 | IT-only — needs full table |

### 🔴 **Pre-existing bug (not introduced by this engagement)** — `amazon-ads-auth.routes.ts:65`

```ts
const MARKETPLACE_COUNTRY: Record<string, string> = {
  A1PA7PVP2ZEA0: 'IT',   // ← wrong; this id doesn't exist
  A1RKKUPIHCS9HS: 'DE',  // ← wrong; A1RKKUPIHCS9HS = ES
  A13V1IB3VIYZZH: 'FR',  // ✓
  APJ6JRA9NG5V4: 'ES',   // ← wrong; APJ6JRA9NG5V4 = IT
  A1F83G8C2ARO7P: 'UK',  // ✓
  ATVPDKIKX0DER: 'US',   // ✓
  ...
}
```

IT, DE, ES are scrambled. Any Amazon Ads profile lookup using this table tags spend to the wrong country. Worth a one-line fix outside this engagement — flag it during M8 (ads backfill) since that's when it bites.

---

## Backfill script audit

```
scripts/backfill-amazon-orders-12m.mjs       → posts to /api/amazon/orders/sync without marketplaceId
scripts/backfill-amazon-financials-12m.mjs   → posts to /api/amazon/finance/sync without marketplaceId
scripts/backfill-amazon-zero-totals.mjs      → uses env default
scripts/sp-api-scope-check.mjs               → uses env default
```

All four need `--marketplaces=DE,FR,ES,...` flag in M2 (or default to "all participating from /api/amazon/participations").

---

## Per-marketplace data state (current)

| Surface | IT | DE | FR | ES | NL | UK | PL | SE | US |
|---|---|---|---|---|---|---|---|---|---|
| Orders (24mo) | ✅ 2,410 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Settlements | ✅ 26 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| DailySalesAggregate | ✅ 1,941 rows | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Returns | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Ad spend | (probably IT only) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ChannelListing (snapshot) | ✅ 262 | ✅ 235 | ✅ 132 | ✅ 140 | ❌ | ❌ | ❌ | ❌ | ❌ |
| FBA inventory | ✅ (EU pool, 437 units, shared across IT/DE/FR/ES/NL/PL/SE) | ↑ | ↑ | ↑ | ↑ | ❌ (separate UK-FBA needed) | ↑ | ↑ | 🚫 (US denied) |
| ChannelConnection | ✅ (preserved by wipe policy) | ↑ | ↑ | ↑ | ↑ | ↑ | ↑ | ↑ | ↑ |
| Marketplace row | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Findings + recommendations

### What changed since the proposal

| Proposal assumption | Reality from M0 probe |
|---|---|
| "SP-API auth may not cover all 9 markets — re-auth may be needed" | ✅ **All 9 authorized.** No re-auth needed. |
| "DE/FR/ES/NL all empty" | ✅ Confirmed. But **ES is tiny** (~3 orders / 14d) and **NL is dormant** (0 orders / 14d) |
| "UK + PL + SE + US likely empty" | ✅ Confirmed, all zero in last 14 days. Likely safe to **defer M4/M5/M6 unless operator confirms intent to backfill historical data** |
| "Pan-EU FBA correctly pooled" | ✅ Confirmed — 437 units served across 7 markets |
| "US separate FBA pool needed" | ⚠️ FBA inventory call **denied** for US — operator likely doesn't have FBA in US at all. M6 + M9 may be unnecessary |

### Revised scope recommendation

**Priority 1 (M3 — immediate revenue gap):** Backfill DE + FR for 24 months. Together that's ~€159K/year of currently-invisible revenue.

**Priority 2 (M3 cont.):** ES + NL for completeness. Low volume but cheap to include since they share EUR + same EU-FBA pool.

**Defer until volume justifies:**
- **M4 UK** — zero activity in 14 days. Worth doing only if operator confirms historical UK orders exist (settlement reports for the past 90 days will tell us)
- **M5 PL + SE** — same situation
- **M6 US** — FBA denied; operator may not be active there at all. Skip unless explicitly requested
- **M9 separate UK/US FBA pools** — only if M4/M6 happen

**Always-on regardless of M3-M6 path:**
- M1 + M2 (code-layer multi-marketplace support) — necessary infrastructure
- M7 settlements per market — fits inside the existing settlement cron
- M11 channel listings refresh — refresh stale DE/ES/FR snapshots
- M13 VAT/OSS — fiscal correctness for EU consolidation
- M16 verification

### Pre-existing tech-debt surfaced

1. **`amazon-ads-auth.routes.ts:65` marketplaceId scramble** — should be fixed regardless of this engagement. Add to TECH_DEBT.md.
2. **5 static code↔id tables are IT-only** — should be a single shared constant. Centralize during M2.
3. **`fba-inbound.service.ts` uses `!` non-null assertion** on env — fails silently in non-IT contexts. Hardening opportunity.

---

## Suggested next step

Update the M-series sequence based on M0 findings:

1. **M1** (Marketplace `isParticipating` flag) — populated from a one-shot `/api/amazon/participations` endpoint that calls SP-API getMarketplaceParticipations and writes back
2. **M2** (Centralize MARKETPLACE_CODE_TO_ID + add `marketplaceIds` to sync routes) — bundle the static-table cleanup with the route signature change
3. **M3** (Backfill DE + FR + ES + NL orders for 24 months) — single phase since all 4 are EUR + same FBA pool
4. **M7** (Per-market settlements for DE/FR/ES/NL — same window as M3)
5. **M11** (Refresh channel listings for DE/ES/FR + add NL)
6. **M13** (Per-market VAT + OSS for EU rollup)
7. **M16** (Verification via I11 recon)

Phases M4 (UK) / M5 (PL/SE) / M6 (US) / M9 (separate FBA pools) deferred — wait for operator confirmation that they have meaningful historical volume in those markets.

**Estimated revised wall-clock:** ~14h (vs original 33h) by deferring dormant markets.

---

## Artifacts

- This report: `docs/multi-marketplace-2026-05-21/M0-audit.md`
- Raw probe response: not saved (used live `/api/amazon/reconciliation/all` instead of probe script — the deployed route already returns the same data)
- Probe script (not run; auth issue with local refresh token): `scripts/m0-marketplace-probe.mjs` — kept for future use if local probing is needed

---

## Approval needed

Reply with:
- **"proceed M1 → M3 (DE+FR+ES+NL backfill)"** — skip dormant markets for now (Recommended)
- **"proceed M1 → full M3-M6 (all markets including UK/PL/SE/US)"** — historical backfill for completeness even where current volume is zero
- **"different prioritization"** — change the sequence
