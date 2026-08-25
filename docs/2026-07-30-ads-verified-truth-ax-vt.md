# AX-VT — Verified Truth for Amazon Ads

**Status:** PROPOSAL — awaiting gate. No code changed.
**Date:** 2026-07-30
**Trigger:** Operator created a portfolio + 11 campaigns in Nexus. Amazon's console shows the portfolio empty.

---

## 1. What actually broke

Three independent defects, all verified against the code and the live DB. They compound: the first
causes the divergence, the second hides it, the third erases the evidence.

### D1 — the cause: `portfolioId` is never sent to Amazon on create

`apps/api/src/services/advertising/ads-api-client.ts:887` — `CreateCampaignInput` has **no
`portfolioId` field**:

```ts
export interface CreateCampaignInput {
  name: string
  targetingType: 'MANUAL' | 'AUTO'
  dailyBudget: number
  state?: 'enabled' | 'paused'
  startDate?: string
  biddingStrategy?: 'legacyForSales' | 'autoForSales' | 'manual'
}
```

and the v3 request body it builds (`:901`) omits it accordingly — `name`, `targetingType`, `state`,
`budget`, `dynamicBidding`, `startDate`. Nothing else.

`ads-create.service.ts:47` then calls it without the portfolio, and saves the portfolio **locally
only** nine lines later:

```ts
const r = await createCampaign(ctx, { name, targetingType, dailyBudget, biddingStrategy, state: 'enabled' })
//                                    ^^ portfolioId is not in this object and cannot be
...
portfolioId: input.portfolioId || null,   // ← :56, local row only
```

Every builder funnels through `createCampaignLocal` and therefore loses it:

| Builder | Route | Passes `portfolioId`? | Reaches Amazon? |
|---|---|---|---|
| SP Super Wizard | `advertising.routes.ts:932` | yes | **no** |
| Single Campaign | `:1104` | yes | **no** |
| Replicate / Blueprint | `ads-blueprint-apply.service.ts:344` | yes | **no** |
| Architect | `ads-architect.service.ts:93` | no | no |

The comment at `ads-blueprint-apply.service.ts:342` reads *"AX3.0 — join the destination portfolio.
Without it replicas landed outside every portfolio, invisible to portfolio budgets and rollups."*
That diagnosis was right and the fix was applied one layer too high — it hands `portfolioId` to a
function that drops it.

`updateCampaign` **does** support the field (`ads-api-client.ts:744`, `v3Campaign.portfolioId`), and
`assignPortfolioDirect` uses it. So the write capability exists; only the create path is missing it.

### D2 — why nobody was told: portfolio drift is structurally undetectable

`ads-campaign-settings-sync.service.ts:68` declares `portfolioId` a tracked drift field:

```ts
const CAMPAIGN_DRIFT_FIELDS = ['status', 'dailyBudget', 'biddingStrategy', 'portfolioId', 'targetingType']
```

But the sync never populates it. The `data` object handed to `recordCampaignDrift` as `incoming`
(`:196`–`:211`) sets `dynamicBidding`, `dailyBudget`, `status`, `biddingStrategy`, `targetingType` —
and never `portfolioId`. `diffFields` (`ads-core/drift.ts:147`) then discards it on the first line
of the loop:

```ts
if (!(f in theirs)) continue      // ← portfolioId is never in `theirs`. Always skipped.
const t = normaliseForCompare(theirs[f])
if (t == null) continue           // ← and even if it were, Amazon reports NULL here, so still skipped
```

Two independent guards each make this exact case invisible. The second is the more interesting one:
`t == null → continue` was presumably added so a partial API response can't masquerade as somebody
clearing a value — but it also means **"Amazon has no value where we have one" can never be
reported for any field.** That is the highest-signal drift class there is.

Live DB confirms it empirically:

```
AdDrift rows by field: [{ field: "biddingStrategy", count: 169 }]
```

169 rows for `biddingStrategy` prove the detector runs. **Zero** `portfolioId` rows across 62
campaigns in 9 portfolios. `portfolioId` in `CAMPAIGN_DRIFT_FIELDS` is dead configuration.

### D3 — evidence destruction: the portfolio sync silently converges local to Amazon's null

`ads-portfolio.service.ts:56`, `linkCampaignMembership` — no null-guard at all:

```ts
for (const [pid, ids] of byPid) {
  if (!ids.length) continue
  await prisma.campaign.updateMany({ where: { externalCampaignId: { in: ids } }, data: { portfolioId: pid } })
  if (pid) linked += res.count     // ← counts only non-null, but WRITES null too
}
```

When Amazon reports a campaign in no portfolio, `pid` is `null` and that null is written into
`Campaign.portfolioId`. The docstring justifies it — *"Amazon is source-of-truth here … so setting
portfolioId=null for campaigns Amazon reports as unportfolio'd is correct, not destructive."*

That reasoning holds only if our writes actually reach Amazon. Given D1 they don't, so the sweep
turns a visible contradiction into a clean, self-consistent lie: the campaigns quietly leave the
portfolio in Nexus too, and the operator who reported the problem now can't reproduce it.

### Measured scope

```
Campaigns with a local portfolioId:            62
  … with an Amazon externalCampaignId:         62   (all repairable via PATCH)
  … that never reached Amazon:                  0
Distinct portfolios affected:                   9
```

All 62 exist on Amazon and are allowlisted, so repair is a metadata PATCH — no campaign needs
recreating, no spend is at risk.

**Not all 62 are broken.** Portfolios dated `2026-07-01` (`IT_Gale`, `Moss_Jacket`, `Misano_Jacket`,
`ES_Gale`, `DE/FR_Gale`) were created in Seller Central and their membership was pulled *in* by
`linkCampaignMembership` — those are correct. The Nexus-built ones (`IT AIREON`, 2026-07-28, 11
campaigns — matching the operator's report exactly, and `Xavia GALE IT`, 11) are the broken set. So
the repair must be a read-diff-then-PATCH, never a blind push. Fixing D2 is what makes the true
scope knowable.

### One open question, resolved empirically not from docs

Amazon's public docs don't clearly state whether `portfolioId` is accepted on **create** for SP v3
(it is documented as optional on Sponsored Brands create, and the field is part of the campaign
resource). Rather than guess, Phase 1 settles it with one live campaign and a read-back. Both
outcomes are handled:

- **Accepted on create** → single-call path, campaign is born in the portfolio.
- **Rejected on create** → create-then-PATCH, using `updateCampaign`'s `portfolioId` which is
  already proven in production via `assignPortfolioDirect`.

Either way the operator-visible behaviour is identical. The fallback is not speculative.

---

## 2. What exists today, and what each piece is for

The advertising system is far larger than the bug suggests — 44 pages, ~90 API services, ~8.5k lines
of routes. The gap is not features. It is **proof that the features landed.**

### Wiring, create path

```
Builder UI (4 kinds)                    apps/web/src/app/marketing/ads/campaign-builder/*
  · sp-super-wizard   full 11-campaign structure  (← used for IT AIREON)
  · single            one campaign
  · replicate         clone an existing structure
  · quick / guided    presets
        │  portfolioId chosen in PortfolioPicker.tsx
        ▼
advertising.routes.ts  (prefix /api)    :932 wizard · :1104 single · :1521 replicate
        ▼
ads-create.service.ts  createCampaignLocal()      ← ✗ D1: portfolioId dropped here
        ├── checkAdsWriteGate()                    ads-write-gate.ts
        ├── createCampaign()                       ads-api-client.ts → POST /sp/campaigns v3
        └── prisma.campaign.create()               local row keeps portfolioId
        ▼
AdvertisingActionLog                     audit row, always written
```

### Wiring, the truth-keeping layer (where the gap is)

| Component | File | Purpose | Portfolio-aware? |
|---|---|---|---|
| Write gate | `ads-write-gate.ts` | 5 conditions before any live write: mode=live, active production connection, `writesEnabledAt`, per-campaign `liveBidWritesEnabled`, non-null external id | n/a |
| Outbound queue | `OutboundSyncQueue` + `ads-sync.worker.ts` | async dispatch, 3 HTTP retries → 3 queue attempts → dead-letter | bids only |
| Typed mutations | `AdMutation` (AX-ZD.1) | one row per (entity, field); field-scoped pending-write lookup, per-entity serialisation | additive, not on create |
| Settings sync | `ads-campaign-settings-sync.service.ts` | polls Amazon, overwrites local, records drift | ✗ **D2** |
| Drift store | `AdDrift` + `ads-core/drift.ts` | per-(entity,field) drift rows, classified, auto-resolving | ✗ **D2** |
| Portfolio sync | `ads-portfolio.service.ts` | pulls portfolios + membership, upserts local | ✗ **D3** |
| Write reconcile | `ads-write-reconcile.service.ts` | re-pushes FAILED entities, skips permanent 4xx | bids only |
| Integrity check | `ads-sync-integrity.service.ts` | 8-signal snapshot on the 10-min cron → `/api/health` | ✗ no create-verification signal |
| Launch repair | `ads-create.service.ts:130–291` | `pushCampaignStructure`, `reconcileNegativesAndDelivery`, `assignPortfolioDirect` | ✓ manual only |

The pattern is unmistakable. Every truth-keeping mechanism was built for **bid writes** — because
that is where money moves and where failures were felt first. **Structural writes (create, portfolio
membership, naming, hierarchy) have no equivalent.** `pushCampaignStructure` and
`assignPortfolioDirect` exist and are correct, but they are manually-invoked repair tools reachable
only by curl. Nothing runs them, nothing detects that they are needed, and no UI surfaces the need.

This is precisely why the launch reported success: the wizard checks `if (!camp.externalCampaignId)
notOnAmazon.push(...)` — it verifies *the campaign exists*, and never verifies *what it looks like*.

### Feature inventory (already shipped)

Account Overview · Dashboard · Budget Manager · AI Advertising · AI Control (autopilot) ·
Suggestions · Recommendations · Alerts & Health · Analytics · Ad Manager · Portfolios · Bulk
Operations (bulksheet round-trip) · Rules & Automation · AMC · Reporting + Brand Metrics · Change
Log · Settings · eBay Ads (parallel rail)

Services behind them: Bayesian bidding, target-ACoS, bid suggest/optimizer/suppression, dayparting
(+intel), budget pacing/enforce/pools + rebalancer, keyword harvest + funnel + n-gram + negatives +
conflicts, SQP, share-of-voice/impression-share, top-of-search, incrementality, momentum, anomaly
guard, retail readiness, true-profit rollup, rank controller + self-competition, Marketing Stream
(intraday), Data Kiosk economics, FBA fees + storage age, DSP, audiences, blueprints, ontology.

---

## 3. Market research — what the best platforms do

Sources at the end. Summary of where each sits and what is worth taking.

| Platform | Price | Positioning | What they do better |
|---|---|---|---|
| **Pacvue** | $500+/mo | Enterprise, 100+ retailers. Helium 10 Ads was rebuilt on Pacvue in Feb 2025. | **Governance: approvals, guardrails, "full change transparency", audit at every step.** Real-time bid/budget/pacing/dayparting/SOV as one automation layer. |
| **Perpetua** | $695+/mo | Goal-based automation | Bids re-evaluated **every 15 min** against target ACoS/ROAS. Structured launches driven by harvesting. |
| **Skai** | enterprise | 100+ publishers | Intraday bid optimization via retailer stream feeds. |
| **Quartile** | $895+/mo | Patented ML | Hourly bid adjustments. |
| **Teikametrics** | $149+/mo | ML bidding, mid-market | Price/accessibility. |
| **Helium 10 Ads** | mid | SMB, suite-integrated | Rules UX in the Ad Manager grid — rules live *on the row*, not on a separate page. |
| **Scale Insights** | flat fee | $2–10k spend tier | Flat pricing. |

### Honest read on relative position

On **breadth of capability, Nexus already meets or exceeds this field.** Dayparting, SOV,
incrementality, budget pools, n-grams, Bayesian bidding, intraday Marketing Stream, AMC surface,
true-profit — several of these are the specific things Pacvue and Quartile charge $500–895/mo for.
Nexus additionally has something none of them have: the ads system sits in the same database as
inventory, cost, margin and listing health. Perpetua is explicitly criticised in reviews for having
*"no visibility into margins, inventory, or pricing."* Nexus has all three.

There are exactly two things the commercial platforms genuinely do better:

1. **Multi-retailer breadth** — Pacvue's 100+ retail media networks, Skai's 100+ publishers.
   *Irrelevant to Xavia:* the active channels are Amazon, eBay and Shopify, and the eBay rail
   already exists. Do not build this.

2. **Governance and change transparency** — and this is the whole ballgame. Pacvue's marketing leads
   with *"approvals, guardrails, and full change transparency"* and *"ability to audit at every
   step."* That is not a feature list, it is a **trust contract**: when the platform says it did
   something, it did it, and you can prove it. This bug is exactly that contract being absent.

The industry-standard pattern for keeping it, per the reconciliation literature: **scheduled
reconciliation jobs that compare key field values between source and target to detect silent
failures** — not just record counts. Nexus has this for bids and lacks it for structure.

### Conclusion the research points to

The right move is **not** to add features. Nexus is already feature-rich past its price-tier peers.
The move is to make the existing surface **provable** — close the structural-write verification gap
so that "Nexus says X" and "Amazon does X" cannot silently diverge, for *any* field, not just bids.
That single capability is what separates a $150/mo tool from a $700/mo one, and it is the thing that
just failed.

---

## 4. Recommended approach

**Principle: no write is complete until Amazon has been re-read and agrees.**

The existing bid path already almost implements this (`liveBidWritesToday` as delivery proxy,
`lastSyncStatus`, DeliveryChip, reconcile sweep). Generalise that from *bids* to *every field we
write*, and make the absence of confirmation a first-class, visible state.

Four design decisions, with the rejected alternatives:

**a) Verify by read-back, not by response parsing.** A 200 from `POST /sp/campaigns` proves the
campaign was created; it says nothing about whether the portfolio stuck. Read the entity back and
compare against intent. *Rejected: trusting the create response — that is what we do now.*

**b) Persist intent separately from observed state.** Store what the operator asked for
(`intendedPortfolioId`) alongside what Amazon reports. Drift is then a comparison of two recorded
facts, not an inference. `AdMutation` (AX-ZD.1) is the right home — it is already per-(entity,field)
and additive. *Rejected: a boolean `verified` flag — it can't tell you what was wrong.*

**c) Make "Amazon has no value where we have one" reportable.** Fix `diffFields` to distinguish
*field absent from response* (skip — partial response, correct behaviour) from *field present and
null* (report — this is real). Requires the read layer to preserve key presence. This is the
narrow, surgical fix to D2 and it generalises to every field.

**d) Converge only after recording.** `linkCampaignMembership` may keep treating Amazon as truth,
but it must open a drift row *before* overwriting a non-null local value with null. Evidence first,
convergence second. *Rejected: stop converging — Amazon genuinely is source of truth for membership;
the defect is silence, not convergence.*

---

## 5. Design system

Per the standing rule, all new UI comes from `apps/web/src/design-system` — no bespoke components.

**Current state of the ads console.** `/marketing/ads` is the H10-look console; the DS README
confirms this look is now canonical and the `.h10-*` → `.nx-*` rename plus ~290-page migration is
Phase 9, still pending. `PortfoliosClient.tsx` already imports DS correctly — `Button`, `Select`,
`Input`, `Modal`, `ToastProvider` plus `tokens.css`/`primitives.css`/`components.css` — but renders
its table hand-rolled in `portfolios.css`.

**Decisions for this work:**

1. **New tables use the DataGrid stack.** Per the standing rule: `DataGrid` + `GridToolbar` +
   `FilterBar` (the `/products/next` pattern), all four DS stylesheets imported. This applies to the
   two new surfaces (membership diff, verification ledger). The existing hand-rolled portfolio table
   is *not* in scope — being surgical.
2. **Verification state reuses the existing `Tone` vocabulary** — `neutral · info · success ·
   warning · danger`. Verified → `success`, unconfirmed → `warning`, contradicted → `danger`,
   in-flight → `info`. No new colour semantics.
3. **The DeliveryChip pattern is the precedent to extend**, not replace — it already communicates
   live/pending/failed/sandbox for bids in the rank cockpit. Structural verification should read as
   the same idea in the same visual language.
4. **Watch the two known DS traps** if drawers or dropdowns are used: `.nds-gridcard` has
   `overflow:hidden` and clips a dropdown's last option on short cards (hit-test, don't trust the
   DOM); and DS `Drawer` (z-61) sits above `Modal` (z-50), so any confirm inside a drawer must use
   the `Drawer overlay=` slot — `StudioConfirm` is the reference.
5. **Guard note:** the pre-push DS ratchet greps comments, so the raw element name for a dropdown
   must not appear even in a comment — describe it in words.

---

## 6. Phases

Each phase is independently shippable and verified on prod. Estimates are working sessions.

### AX-VT.1 — Fix the create path + repair the 62 · **P0, ½ session**
- Add `portfolioId?: string` to `CreateCampaignInput`; include it in the v3 create body when present.
- Pass `input.portfolioId` through at `ads-create.service.ts:47`.
- Settle the docs question live: create one throwaway campaign on IT with a portfolio, read back,
  archive it. If create rejects the field → create-then-PATCH via the proven `updateCampaign` path.
- Add `portfolioId` to `ads-architect.service.ts:93` (the one builder that never passed it).
- Repair endpoint: for every campaign with a local `portfolioId`, read Amazon, and PATCH **only**
  where Amazon disagrees. Dry-run first — expect ~22 (the two Nexus-built portfolios), not 62.
- **Verify:** re-read all 62 from Amazon; every one agrees. Operator confirms in Amazon's console.

### AX-VT.2 — Make the drift detector able to see this · **P0, ½ session**
- Populate `portfolioId` into the settings-sync `incoming` object.
- Teach `diffFields` to separate *absent key* from *present-and-null*; report the latter.
- Regression test: local set, Amazon null → exactly one `AdDrift` row, classified correctly.
- **Verify:** deliberately unassign one campaign in Seller Central; a drift row appears within one
  sync cycle. This is the test that proves D2 is actually closed rather than moved.

### AX-VT.3 — Stop the evidence destruction · **P0, ¼ session**
- `linkCampaignMembership`: before overwriting a non-null local `portfolioId` with null, open a
  drift row. Convergence still happens; it is no longer silent.
- **Verify:** the AX-VT.2 test, with the portfolio sync running — drift row survives.

### AX-VT.4 — Create-time read-back verification (the systemic fix) · **P1, 1–2 sessions**
- Every builder launch ends with a read-back of what it created (campaign fields, ad-group, portfolio
  membership, target/ad counts) compared against intent.
- Persist the result as a **launch verification receipt**: intended vs observed, per field.
- The launch UI shows the receipt instead of a bare success — "11 campaigns created, 11 verified in
  portfolio IT AIREON" or an explicit, actionable list of what did not land.
- Extends `notOnAmazon` from *existence* to *fidelity*.
- **Verify:** launch a 2-campaign structure on prod; receipt matches an independent Amazon read.

### AX-VT.5 — Structural reconcile on a schedule · **P1, 1 session**
- Generalise `ads-write-reconcile.service.ts` beyond bids: a sweep that re-pushes any structural
  field where intent ≠ observed, honouring `isRetryableSyncError` so it can't loop on permanent 4xx.
- Add a create-verification signal to `ads-sync-integrity.service.ts` so it lands on `/api/health`
  where someone already looks.
- **Verify:** unassign a campaign in Seller Central; the sweep restores intent within one cycle *or*
  records an unresolvable drift — never silence.

### AX-VT.6 — Trust surface · **P2, 1–2 sessions**
- One console answering "is Nexus telling me the truth right now?": open drift, dead letters, pending
  writes, failed verifications, per-entity delivery state.
- DataGrid stack; `Tone` vocabulary; DeliveryChip extended to structural fields.
- Mostly a read model over data AX-VT.2–5 already produce.

### AX-VT.7 — Portfolios as first-class · **P2, 1 session**
- Bulk move campaigns between portfolios (the repair tool from VT.1, promoted to a real feature).
- Portfolio budget caps are already read from v3 (`budgetAmount`/`policy`/`inBudget`) — surface
  pacing against them.
- Portfolio-level drift + rollups.

### AX-VT.8 — Market-parity gaps · **P3, scope separately**
Only the genuinely entitled-and-unbuilt items, per the live entitlement probe of 2026-07-29:
Sponsored TV, Amazon Attribution. **AMC and DSP are blocked at Amazon — do not build.** Multi-retailer
breadth is explicitly out of scope (Amazon + eBay + Shopify only).

### Sequencing

VT.1–VT.3 are one push: they are small, they are P0, and each is load-bearing for the others' tests.
VT.4 is the phase that actually prevents recurrence — the rest of the class of bug, not this
instance. VT.6–VT.8 are value-add and can wait.

**Not in scope:** flat-file editors, FBA quantity, the existing import, the hand-rolled portfolio
table, any bid-engine behaviour change.

---

## Sources

- [Best Amazon PPC Tools 2026 — SalesDuo](https://salesduo.com/blog/best-amazon-ppc-tools-comparison/)
- [Pacvue — Real-Time Automation & Optimization](https://pacvue.com/platform/real-time-automation-and-optimization/)
- [Pacvue — Platform](https://pacvue.com/platform/) · [Retail Media Ad Management](https://pacvue.com/retail-media-ad-management/) · [Marketplaces](https://pacvue.com/marketplaces/)
- [Pacvue — dayparting + share of voice during shopping events](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Perpetua 2026 operator review — Ecommerce Times](https://ecommerce-times.com/perpetuas-amazon-ad-platform-a-2026-operator-review/)
- [Pacvue vs Perpetua — atom11](https://www.atom11.co/blog/pacvue-vs-perpetua)
- [Helium 10 Ads (Adtomic) guide 2026 — AffNinja](https://affninja.com/helium-10-ads-guide/)
- [Helium 10 Ads launch — Helium 10](https://www.helium10.com/blog/helium-10-ads/)
- [Best Amazon PPC Software 2026 — Prism/Calibrated Intelligence](https://calibratedintelligence.com/best-amazon-ppc-software/)
- [Managing campaigns with Amazon Advertising Portfolios — Intentwise](https://www.intentwise.com/blog/how-to-manage-campaigns-with-amazon-advertising-portfolios)
- [Monitoring integration errors and sync issues — Apollo](https://www.apollo.io/insights/how-to-monitor-integration-errors-and-resolve-sync-issues)
- [Retail Media Automation 2026 platform comparison — Osmos](https://www.osmos.ai/blog/automation-auctions-the-science-of-scalable-retail-media)
