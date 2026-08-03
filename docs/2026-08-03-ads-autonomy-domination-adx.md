# ADX — Ads Autonomy & SERP Domination

**Status:** ADX.0–2 COMPLETE · ADX.3 next
**Date:** 2026-08-03
**Goal:** the ads account runs itself, holds page-one real estate across products that share a keyword set, and never requires the operator's attention — while the operator retains explicit, per-lever control over everything.

---

## Part 1 — What exists today

### 1.1 Scale

| Layer | Size |
|---|---|
| `apps/api/src/services/advertising/` | 24,519 lines, 60+ services |
| `apps/api/src/routes/advertising.routes.ts` | 9,936 lines |
| `apps/api/src/jobs/` (ads) | 2,913 lines, 17 jobs |
| `/marketing/ads/*` — **the new console, current work** | 23 pages |
| `/marketing/advertising/*` — legacy #1 | ~40 pages |
| `/marketing/ads-console/*` — legacy #2 | 12 pages |
| Distinct `/api/advertising/*` endpoints called by UI | 107 |
| Ads-related Prisma models | ~70 |

This is not a greenfield build. Nearly every capability the market sells is already present in some form, and **none of it is in daily use.** ADX.0 measured why: the automation rule engine has never executed successfully — 693,503 failures, 0 successes. See §1.10, which is the centre of this document.

### 1.2 The data spine (read path)

| Component | Purpose |
|---|---|
| `ads-sync.job` (30 min) | Pulls campaign/ad-group/target/product-ad structure from Amazon |
| `ads-metrics-ingest.service` (hourly) | Ads Reports API → `AmazonAdsDailyPerformance` |
| `AmazonAdsHourlyPerformance` | Hour-grain performance — the dayparting substrate |
| `ads-marketing-stream.service` + AMS | Amazon Marketing Stream → intraday "Today" numbers |
| `AmazonAdsSearchTerm` | Search-term harvest substrate |
| `AmazonAdsPlacementReport` | Top-of-Search vs Rest-of-Search vs Product-page split |
| `sqp.service` | Search Query Performance — competitive share |
| `ads-brand-metrics.service` | Brand Metrics (awareness/consideration funnel) |
| `ads-impression-share.service` | **Derived** Share of Voice + cannibalization detection |
| `ads-tos-is-ingest.service` | `topOfSearchImpressionShare` — the real Amazon IS metric |
| `KeywordRank` | Organic/paid rank time-series (ingested, not API — Amazon doesn't expose it) |
| `ads-structural-reconcile.service` (6-hourly) | Compares whole account vs Amazon, records disagreement |

### 1.3 The decision layer

| Component | Purpose |
|---|---|
| `AutomationRule` + `advertising-rule-evaluator.job` | Generic trigger→conditions→actions engine |
| `automation-templates.ts` | ~30 pre-built rules (ACOS spike, ROAS scale, harvest, retail guard, profit protection, margin breach, NTB scaling…) |
| `automation-action-handlers.ts` | 1,187 lines of action implementations |
| `ads-bid-optimizer.service` | Target-ACOS bidding |
| `ads-bayesian-bidding.service` | Bayesian smoothing for thin-data targets |
| `ads-target-acos.service` | Profit-native ACOS (uses real fees + COGS) |
| `rank-controller.ts` + `ad-rank-defend.job` | The impression-share control loop |
| `ads-top-of-search.service` | Top-of-Search defense handler |
| `ads-dayparting-refresh.service` + `ad-dayparting.job` | Hour-of-day bid/placement steering |
| `budget-pool-rebalancer.service` | Moves budget between campaigns in a pool |
| `ads-budget-pacing.service`, `ads-budget-enforce.service` | Monthly cap + pacing |
| `ads-harvest.service`, `ads-negative-kw.service` | Search-term graduation + negation |
| `keyword-conflicts.service` | Cross-campaign keyword collision detection |
| `ads-autopilot.service` | Autonomy orchestration |
| `ads-suggestions.service` / `AdsRuleSuggestion` | Propose-only mode: rule matches write a suggestion for approval |
| `ads-eligibility.service` | Amazon ad-eligibility probe |
| `ads-retail-readiness.service` | Buy-box/stock guard before spending |

### 1.4 The write path and its safety spine

```
Rule / cron decision
  └─> AdMutation row          (intent, durable)
      └─> OutboundSyncQueue   (BullMQ)
          └─> ads-sync.worker
              └─> ads-write-gate.ts   ← single chokepoint
                  └─> Amazon Ads API
                      └─> ads-write-reconcile / ads-launch-verify  (read-back)
                          └─> AdDrift / AdvertisingActionLog
```

`ads-write-gate.ts` requires **all** of:
1. `NEXUS_AMAZON_ADS_MODE=live`
2. `AmazonAdsConnection.mode === 'production'` **and** `writesEnabledAt != null`
3. payload ≤ `NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS` (default €500)
4. per-campaign live-write allowlist (**default-deny**)
5. daily write cap

Layered on top: `rule.dryRun`, `rule.maxValueCentsEur` (per execution), `rule.maxDailyAdSpendCentsEur` (daily sum), `scopeMarketplace`, plus `rollback.service.ts` and `NEXUS_ADS_AUTOMATION_KILL`.

**This safety spine is genuinely enterprise-grade and is the reason aggressive autonomy is a reasonable thing to attempt here.** It is better than what most of the commercial platforms expose.

### 1.5 The rank/dayparting model — already sophisticated

`RankTarget` is the vocabulary the control loop speaks:

- `targetISPct` — hold this Top-of-Search impression share
- `placement` — which placement to drive
- `acosCapPct` / `maxCpcCents` — economic ceilings
- `biasPct` / `jumpStartPct` / `stepUpPct` / `stepDownPct` / `maxBiasPct` / `keepClimbing` — the **motion profile** (how fast to climb, whether to snap or ease)
- `allOut` — ignore the ACOS cap, hold the slot at any cost up to `maxCpcCents`
- `pause` + `floorBidCents` — suppress via low bid (never a real pause, per house rule)
- **`lanes`** — drive Top **and** Rest-of-Search **and** Product-pages simultaneously in one combined write
- `bidMode` — hold / absolute / suppress the base bid the multipliers stack on

`RankScheduleGroup` → `AdSchedule` gives named weekly plans across many campaigns, with `RankScheduleEvent` for dated overrides (Black Friday) and `RankScheduleVersion` for plan history.

**The `lanes` field is the multi-placement SERP-coverage engine from the previous conversation — already modelled, already in the engine.**

### 1.6 What is actually running on prod

Railway (`@nexus/api`, production) — variable **values** are redacted to me, so I can confirm which keys exist, not what they are set to. Keys that are **entirely absent** are unambiguous, because the code self-gates on their presence:

**Definitively OFF (key absent):**

| Flag | Consequence |
|---|---|
| `NEXUS_ENABLE_TOS_DEFENSE_CRON` | **`ads-tos-defense.job` never schedules.** The Top-of-Search defense loop — the single most direct SERP-domination mechanism in the codebase — does not run. |
| `NEXUS_BUDGET_ENFORCE_APPLY` | Budget enforcement observes but never applies |
| `NEXUS_ADS_RETAIL_GUARD_APPLY` | Retail guard detects but never pauses |
| `NEXUS_AMS_SQS_QUEUE_URL` | SQS poll path off (AMS arrives via the push/`NEXUS_AMS_INGEST_SECRET` path instead) |

**Set, value unknown — RESOLVED by ADX.0 via `CronRun` evidence (§1.10):** rank-defend, dayparting, autopilot, budget-pool-rebalance, tos-is-ingest, sqp-ingest and the ads-report cycle all fire on schedule. `ads-tos-defense` and `ads-structural-reconcile` confirmed absent. 113 distinct jobs ran in 14 days — the fleet is far more alive than the flag list implied.

**Absent entirely** are all `NEXUS_ADS_*_SCHEDULE` overrides → every cron runs on its in-code default cadence.

### 1.7 Known-open defects carried in from prior work

- **All-out hours have no CPC ceiling** — `own-top-allout` has `maxCpcCents = null` on 13 of 16 schedules, 3 of them live, ~8 h/day unbounded to +900%.
- **~2.5k non-ads price/qty dead letters** still queued.
- **AMS coverage is per-campaign** — schedules have 1–5 days of data where the account has 56. Any per-schedule ratio is currently unsafe.
- **Three parallel consoles** — see §1.8.

### 1.8 Three consoles, one engine

The automations were built on the legacy advertising pages. `/marketing/ads/` is the new console and the current work. There are in fact **three** surfaces:

| Surface | Role | Notable contents |
|---|---|---|
| `/marketing/advertising/*` | Legacy #1 — the original feature-rich console, its own grouped `AdvertisingSidebar` | Rules engine, rule library, execution history, automation analytics, autopilot, dayparting, harvest, Share of Voice, iROAS, retail readiness, DSP, audiences, n-grams, budget pools, pacing, true profit, feeds, events, momentum, architect, funnel, goals |
| `/marketing/ads-console/*` | Legacy #2 | The "187+ automation catalog" (`AutomationHub`), `RankPlacementCockpit` (1,189 lines), `DaypartingTab`, rank editors |
| `/marketing/ads/*` | **New — H10/Adtomic-matched** | 1,204-line `RuleBuilder`, schedule builder, rank target/goal editors, full dayparting suite (coverage, blast radius, versions, events, Next-24 preview) |

**The critical fact: all three call the same backend.** They are three UIs over one rule engine, one `AutomationRule` table, one write gate. So carry-over is a *UI* problem, not a re-implementation problem — dramatically cheaper than it looks.

But it is also a **control risk, not merely untidiness**: three surfaces mutating one engine means a rule changed on legacy shows stale or contradictory state on the new console. That directly undermines "proper control of everything."

### 1.9 The carry-over inventory

Roughly **55 of the 107 endpoints have no UI in the new console.** The ones that matter for this plan:

**Autonomy control — already exists as an API, only legacy has UI:**
- `GET /advertising/autonomy/status` · `POST /advertising/autonomy/pause-all` · `POST /advertising/autonomy/resume` (`advertising.routes.ts:6211–6232`)
- `GET /advertising/automation/state` (`:6444`)
- `automation-analytics` · `automation-impact` · `automation-feed`

**Write-gate control:** `connection/enable-writes` · `connection/preview-writes`
**Manual cron triggers:** `cron/ads-sync/trigger` · `cron/advertising-rule-evaluator/trigger` · `cron/true-profit-rollup/trigger` · `cron/fba-storage-age-ingest/trigger` · `dayparting/run-now`
**Optimizers with preview+apply pairs:** `bid-optimizer/*` · `architect/*` · `autopilot/simulate|apply` · `pacing/*` · `goals/*` · `harvest/apply` · `retail-readiness/apply` · `search-terms/promote` · `negative-keywords/create`
**Intelligence:** `incrementality` · `ngrams` · `insights` · `profit/daily` · `top-of-search` · `orders-dayparting` · `trends/sparklines` · `bid-history` · `events`
**Structures:** `budget-pools/*` · `dsp/*` · `audiences/*` · `funnel/*` · `by-product/*` · `mutations/` · `queued-mutations/`

`share-of-voice` is already wired into the new console — the coverage scoreboard is partly a port, not a build.

**This reframes ADX.1 completely.** The autonomy control plane does not need to be built; it needs to be surfaced, unified, and extended. The `pause-all` / `resume` / `status` triad is exactly the global kill switch the plan called for.

### 1.10 ADX.0 RESULTS — measured 2026-08-04 against prod

**Scripts:** `apps/api/scripts/_adx0-control-audit.mts`, `_adx0b-verify.mts`, `_adx0c-rulefail.mts`, `_adx0d-capproof.mts`. All read-only.

#### THE FINDING: the automation rule engine has never worked

```
AutomationRuleExecution, all time:
  FAILED    693,503   (first 2026-06-23, last 2026-08-03 22:18)
  DRY_RUN    24,846
  SUCCESS         0        ← never, not once
```

Every failure is `errorMessage = 'DAILY_CAP_EXCEEDED'`. The cause is a **self-ratcheting counter** in `automation-rule.service.ts:520–530`:

```ts
const todayCount = await prisma.automationRuleExecution.count({
  where: { ruleId: rule.id, startedAt: { gte: dayStart } },   // counts ALL rows…
})
if (todayCount >= rule.maxExecutionsPerDay) {
  await prisma.automationRuleExecution.create({               // …including the one it writes here
    data: { status: 'FAILED', errorMessage: 'DAILY_CAP_EXCEEDED', … },
  })
```

The cap counts the rejection rows it creates. Once a rule reaches its cap, every subsequent tick writes another CAP_EXCEEDED row, which raises the number being checked against. The counter can never come back down within a day, and each rejection feeds the thing rejecting it.

Proof, one rule, one day:

| Rule | Cap | DRY_RUN today | FAILED today |
|---|---|---|---|
| 🎯 Bid optimization (profit-native) | 2 | 2 | **790** |

Account-wide today: **17,107 FAILED vs 642 DRY_RUN** — 96.4% of all rule-engine work is the engine rejecting itself.

Two compounding defects:
1. **The cap counts its own rejections** — self-ratcheting, unrecoverable within a day.
2. **The cap counts dry-run executions.** These write nothing and cost nothing, yet they consume a guard whose purpose is bounding live spend. Observation-only rules exhaust their own spend limit.

Plus a configuration problem: caps are set absurdly low — 3 rules at cap 2, 3 at cap 3, 3 at cap 4. Even with the ratchet fixed, a bid-optimization rule that may act twice a day is decorative.

**This is why you had no control. There was nothing to control — the automation layer has never executed successfully, and the only symptom was a FAILED row you'd have had to go looking for.**

#### What this refutes in my earlier hypothesis

I proposed that control was lost to seven engines contending for the same bid. **The data largely refutes that**, and the correction matters because ADX.1–4 were sequenced around it:

- **Contention is minimal.** 16 of 484 fields (3.3%) touched by >1 actor; **0 events within 1h**, 2 within 6h, 32 within 24h — and the 24h ones are almost all `dl-requeue` (a dead-letter repair tool) handing off with rank-defend, not two optimizers fighting.
- **The oscillation is not a defect.** 2,322 bid flip-flops looked alarming; inspection shows a correctly-functioning daypart — 35¢ at ~06:00, 2¢ at ~22:00, same actor, every day, exactly as configured.
- **Attribution is better than I claimed.** `AdvertisingActionLog.userId` does carry `automation:rank-defend-<scheduleId>`. My "from_human" count was a bad proxy — I read "userId is not null" as "a human did it." The real gap is narrower: **10,348 rows (33%) with null attribution** and 2,386 tagged `user:anonymous` (the known RBAC-SSR issue).

Contention would have become real the moment rules left dry-run — so authority is still needed before ADX.9. It is a prerequisite, not the emergency.

#### What is genuinely healthy

- **Rank-defend works.** 5,311 mutations in 90 days across 35 schedule-scoped actors, nearly all `APPLIED`, doing exactly what the schedules say. The rank/dayparting engine is the one part of this system that functions.
- **The cron fleet is alive** — 113 distinct jobs in 14 days. Far more is running than the Railway flags implied. `ad-rank-defend` (1,341 runs), `ad-dayparting` (1,340), `budget-pool-rebalance` (1,341), `ad-autopilot` (1,341), `tos-is-ingest`, `sqp-ingest`, `ads-report-*` all firing.
- Confirmed off, as predicted: **`ads-tos-defense`** and **`ads-structural-reconcile`** — no runs in 14 days.

#### Secondary findings

- **The propose pipeline barely emits.** 24,846 DRY_RUN executions produced **2 `AdsRuleSuggestion` rows ever** (1 still pending). Even the rules that do run generate almost nothing actionable — a separate defect from the cap ratchet.
- `advertising-rule-evaluator` cron: 47 failures / 1,340 runs (3.5%) + 1 stuck.
- `ads-keyword-bid-resync`: 32 failures / 335 runs (9.6%).
- All 47 advertising rules are `dryRun = true`; 36 are `enabled`.
- Account scale: 216 campaigns, 5,204 ad targets, 45 ad schedules (33 enabled).

### 1.10b The superseded hypothesis (kept for the record)

The original argument was: **at least seven independent engines can write the same bid, and nothing decides who wins, who did it, or what they may not touch.**

The bid writers: `rank-controller` / `ad-rank-defend`, `ad-dayparting`, `ads-top-of-search`, `advertising-rule-evaluator` (via `automation-action-handlers`), `ads-bid-optimizer`, `ads-bid-suppression`, `budget-pool-rebalancer`, plus operator edits and bulksheet imports.

Three primitives are missing.

**1. Authority — nothing decides who wins.**
`claimEntityWrite` (`ads-mutation.service.ts:352`) takes a Postgres transaction-scoped advisory lock so two writers can't corrupt one entity concurrently. That is a *race guard*, not arbitration. Rank-defend sets a bid to €1.20; forty minutes later the ACOS-spike rule sets it to €0.80; dayparting moves it again at the hour boundary. Every write is individually legal, serialized and correct. The result is a bid that oscillates for reasons no human can reconstruct. **Mutual exclusion prevents corruption; it does not prevent contradiction.**

**2. Attribution — the audit trail cannot answer "why."**
`AdvertisingActionLog` records `actionType`, `payloadBefore`, `payloadAfter`, `executionId`, `userId`. It does not record which engine decided, on what evidence, over what data window, with what confidence.

Worse, it is written by only six services — and **`ad-rank-defend`, `ad-dayparting`, `ads-top-of-search` and `rank-controller` write to it zero times.** The four biggest bid movers in the system are invisible to the operator-facing audit trail. Turning on automation and then being unable to see what moved your bids is precisely the experience that ends in "I don't trust this."

**3. Exemption — nothing can be protected.**
`AdTarget` and `Campaign` have no pin, hold, manual-override or excluded-from-automation field. Control is all-or-nothing at campaign granularity via the write allowlist. You cannot say "manage this campaign but never touch this one keyword's bid," which is the single most common thing an operator wants when starting to trust a machine.

**The encouraging part: two of the three already have substrate.** `AdMutation` carries `actor`, `field`, `ruleId`, `changeSetId`, `previousValue`, `intendedValue`, a `SUPERSEDED` state and `holdUntil`. It is described in-schema as "the single field this row intends to change — the point of the model." That is exactly the shape a field-level authority-and-attribution ledger needs. It exists; nothing reads it as one. Attribution and exemption are wiring jobs, not builds. Authority is the genuinely new piece.

### 1.11 What the market teaches about control

The Amazon tool market splits into *approval-first* (recommend, you approve each change) and *guardrails-first* (the machine acts within bounds). The review consensus is consistent: **opaque auto-pilot is what operators reject**, and Perpetua's own weakness is repeatedly named as guardrails that reduce flexibility.

The more instructive analogue is Google Ads, which is a decade ahead on this problem and converged on four things:

- **Per-behaviour opt-in, never a global switch.** You don't enable "automation"; you enable each recommendation type individually.
- **A visible queue before it runs** — review what will be applied today, dismiss what you disagree with.
- **Change history that includes automated actions**, filterable by source, so a machine change is as legible as a human one.
- **Per-behaviour accountability** — for each enabled automation: how many times it applied this week, when it last ran, when you turned it on.

That last one is the trust-building mechanism, and it is the thing Nexus has no equivalent of.

### 1.12 The honest summary

You have roughly **90% of an enterprise ads platform built, roughly 30% switched on, none of it in use, and the reason it isn't used is that it was built as capability without an authority model.** The gap versus Pacvue is not features — you have more levers than Pacvue. It is (a) authority, attribution and exemption, (b) activation, and (c) Sponsored Brands / Display, which have a read path but no create or optimize path.

**This changes what ADX is.** It is not a porting exercise over 55 orphaned endpoints. It is: build the control model that was never there, and let it decide which of the 55 deserve to exist.

---

## Part 2 — Market scan

### 2.1 The field

| Platform | Price | Positioning | Core mechanism |
|---|---|---|---|
| **Perpetua** | $695+/mo | Hands-off ML | Goal-based ("target ACOS, grow to X"), ML bidding, no margin/inventory visibility |
| **Pacvue** | $500+/mo | Enterprise/agency | Rules engine, dayparting, **Share of Voice**, budget pacing, multi-retailer |
| **Quartile** | $895+/mo | Enterprise | Patented ML, **hourly** bid adjustments |
| **Teikametrics** | $149+/mo | Mid-market | ML bidding, Amazon + Walmart |
| **Scale Insights** | flat fee | Small sellers | Deep rule engine |
| **Intentwise** | — | Analytics-first | Data warehouse + STIS reporting |
| **Amazon native** | free | Baseline | Budget rules, rule-based bidding, Performance+, Brand+, **Ads Agent** |

### 2.2 Features worth taking

**From Pacvue:**
- **Share of Voice by tracked keyword** — which brands hold top featured spots, paid vs organic split. This is the SERP-domination scoreboard.
- **Hourly dayparting driven by SOV data**, not just performance.
- Rules engine with inventory-aware and Buy-Box-aware conditions.
- Budget pacing to a monthly target with automatic reallocation.
- Bulk operations at scale.

**From Perpetua:**
- **Goal-based abstraction** — the operator states an outcome, the machine picks the levers. This is the correct interaction model for "doesn't require my attention."
- Automatic keyword harvesting and graduation between campaign tiers.

**From Quartile:**
- Hourly re-bidding rather than daily.

**From Amazon native (important, and free):**
- **Performance+ / Brand+** — Amazon's own ML campaign types.
- **Ads Agent** — AI campaign setup, available via API.
- **Sponsored Products / Sponsored Brands prompts** (open beta Nov 2025 → GA, charged as CPC).
- Native budget rules and rule-based bidding — a commodity now; the market's verdict is that plain if-then rule engines no longer differentiate.

### 2.3 The measurement constraint that shapes the whole plan

**Search Term Impression Share (STIS) and Search Term Impression Rank (STIR) are not available through the Ads API.** They exist only as a console report (Measurement & Reporting → Create Report → Search Term Impression Share), which can be scheduled to run recurrently.

The API exposes only `topOfSearchImpressionShare` on SP and SB reports.

Consequence: true "are we winning this keyword against the field" data must come from a **scheduled console report ingest**, not a live API call. `ads-impression-share.service` already acknowledges this and computes within-account SOV as a proxy. This is a real gap to close, and it is the same gap every competitor has — Pacvue's SOV is built on their own crawling, not on Amazon data.

### 2.4 Where Nexus already beats the market

- **Profit-native ACOS** using real Amazon fees + COGS. Perpetua explicitly cannot see margin.
- **The write gate + read-back + drift detection.** No commercial tool gives you a per-campaign live-write allowlist with default-deny.
- **Motion profiles** (`jumpStartPct` / `stepUpPct` / `keepClimbing`). More expressive than any published competitor bid-ramp control.
- **Blended lanes** — simultaneous multi-placement control in one write.
- Owning the PIM alongside the ads platform: retail-readiness, stock, and Buy-Box are local joins, not integrations.

---

## Part 3 — The goal

> The account holds page-one coverage across the products that share a keyword set, runs profitably against a stated target, and requires zero daily attention. The operator sets intent and boundaries; the machine does everything else; every action is visible, attributable, and reversible.

Three properties, in priority order:

1. **Controllable** — every automation has an explicit mode, scope, and cap, changeable in one place without a deploy.
2. **Autonomous** — in `Auto` mode, no human is in the loop for routine decisions.
3. **Dominant** — coverage across placements and ad types on the shared keyword set, not just one better slot.

### 3.1 The control model

Four primitives, in dependency order. Nothing else in this plan works without them.

**A. Authority — one owner per field.**
Every writable field (`bid`, `budget`, `placement multiplier`, `state`) on every entity has exactly one owner at any moment: `operator`, or a named engine (`rank-defend`, `dayparting`, `rule:<id>`, `bid-optimizer`, …). An engine may only write fields it owns. Ownership is declared, visible, and changeable by the operator.

Conflicts stop being invisible races and become a **declared precedence**: `operator-pin > event override > rank schedule > rule > optimizer > default`. When a lower-authority engine wants a field it doesn't own, it doesn't write — it raises a suggestion. That single change converts "my bids oscillate mysteriously" into "the dayparting schedule owns this bid from 18:00–22:00, and the ACOS rule asked to override it at 19:14 — here's the request."

**B. Attribution — every write carries its reasoning.**
Extend the ledger so every write, cron writes included, records: which engine, which rule/schedule/window, the evidence (metric, threshold, data window, row count), and the resulting before→after. `AdMutation` already has `actor`/`field`/`ruleId`/`changeSetId`; the gap is that the four biggest bid movers bypass `AdvertisingActionLog` entirely. **Non-negotiable rule going forward: no engine may write a field without writing its reasoning in the same transaction.**

**C. Exemption — anything can be protected.**
A pin at any granularity: this account, this campaign, this ad group, this target, this field, optionally with an expiry. Pinned means no engine touches it, and the UI shows the pin wherever the value appears. This is what makes it safe to switch anything on at all — you can always carve out the thing you care about.

**D. Foresight — see it before it happens.**
A single "next 24 hours" view across *all* engines: what will change, when, driven by what, and what it would cost. `next24.ts` and `Next24Preview.tsx` already do this for the rank engine alone; the generalisation is to every writer. Paired with a **dry-run diff**: before enabling any lever, show what it would have done over the last 30 days against real history.

### 3.2 The interaction model

On top of those four, every automation becomes a row with the same four-state mode:

| Mode | Behaviour |
|---|---|
| **Off** | Does not evaluate |
| **Observe** | Evaluates, logs what it *would* do, writes nothing |
| **Propose** | Writes an `AdsRuleSuggestion` for one-click approve/dismiss |
| **Auto** | Executes within its caps and authority, logs reasoning, revertible |

`AdsRuleSuggestion` already implements Propose; `rule.dryRun` already implements Observe. The state machine exists — it is just neither exposed coherently nor bounded by authority.

Following Google's model: **mode is set per behaviour, never globally.** There is no master "automation on" switch, only a kill switch. And each lever carries its own accountability strip — times applied this week, last run, when you enabled it, net effect — so trust is earned with evidence rather than asserted.

Autonomy is then earned per lever: Observe → Propose → Auto, graduating only when a lever's proposals stop needing edits.

---

## Part 4 — Design system and navigation

### 4.1 The constraint

No new sidebar navigation links — neither the app rail (`AppShell.tsx`) nor the ads rail (`ADS_NAV` in `_shell/nav.ts`). New surfaces attach to existing pages as tabs, panels, drawers, or columns.

### 4.2 Where each thing lands

| New surface | Home | Mechanism |
|---|---|---|
| **Autonomy Console** | `/marketing/ads/autopilot` (existing rail entry "AI Control") | Becomes a tabbed page: `Autonomy · Levers · Guardrails · Activity` |
| Coverage / SOV scoreboard | `/marketing/ads/analytics` | New tab |
| Placement-ladder editor | `/marketing/ads/rules-automation/dayparting` | Extends the existing rank-schedule editor |
| SB / SBV / SD creation | `/marketing/ads/campaign-builder` | New builder types alongside the existing five |
| Autonomy status per campaign | `/marketing/ads/campaigns` | New DataGrid column + row drawer |
| Daily digest | `/marketing/ads/dashboard` | Panel |
| Optimizer preview+apply pairs (bid, pacing, architect, goals, harvest) | `/marketing/ads/recommendations` + `/marketing/ads/suggestions` | Tabs — these are all "propose a change, approve it" surfaces, which is exactly what those two pages already are |
| Intelligence orphans (iROAS, n-grams, insights, true profit, momentum) | `/marketing/ads/analytics` | Tabs |
| Budget pools + pacing | `/marketing/ads/budget-manager` | Tabs |
| DSP + audiences | `/marketing/ads/amc` | Tabs — AMC is already the audience/programmatic rail entry |
| Retail readiness, storage age, feeds | `/marketing/ads/health` | Tabs |
| Execution history, automation analytics, impact | `/marketing/ads/changelog` | Tabs |

Zero new rail entries. Zero new top-level routes. Every one of the ~55 orphaned controls maps onto one of the 18 rail entries that already exist — the carry-over needs no navigation growth at all.

### 4.3 Components

From `apps/web/src/design-system` only:
- `DataGrid` + `GridToolbar` + `FilterBar` (the `/products/next` stack) for every table; all four DS stylesheets imported.
- `Tabs` for in-page navigation.
- `Drawer` for per-lever detail — **with confirms passed through the `overlay=` slot** (Drawer is z-61, Modal z-50; a confirm opened normally renders behind it — `StudioConfirm` is the reference).
- `MetricStrip` for the autonomy header, `Heatmap` for the hour-of-day coverage grid, `Banner` for kill-switch state, `Toast` for action feedback.

Known traps to respect: grid cards clip dropdown last-options (`.h10-ds-gridcard` `overflow:hidden`); menus inside sticky grid cells must portal to `document.body`; DataGrid needs scoped `table-layout:fixed` via a plain global class; the DS guard greps comments, so don't write a select element's tag name in a comment.

---

## Part 5 — Phases

Each phase is separately gated. Nothing after ADX.0 begins without explicit approval.

Re-sequenced twice. First after the three-console finding, then again after the diagnosis in §1.10. **The control primitives now come before everything**, including before consolidation — because porting controls you don't trust just relocates the problem, and because authority decides which of the 55 orphans deserve to exist at all.

Carry-over is no longer a phase. It is a criterion: an orphaned endpoint gets adopted when a control need calls for it, and is otherwise redirected at the end.

### ADX.0 — Ground truth ✅ **COMPLETE 2026-08-04**
Measured against prod. Results in §1.10. Headline: the rule engine has never executed successfully — 693,503 failures, 0 successes, caused by a self-ratcheting daily cap. The contention hypothesis was largely refuted.

### ADX.1 — Repair the rule engine ✅ **SHIPPED 2026-08-04** (`2fb3cc1cb`)
Three fixes in `automation-rule.service.ts`:
1. **Stop the ratchet** — the cap must count only executions that *did work*, excluding its own `CAP_EXCEEDED` rows. Count `status IN ('SUCCESS','PARTIAL','DRY_RUN')`, or stop writing a row at all on cap rejection and record the rejection as a counter on the rule.
2. **Exclude dry-run from the cap** — a dry-run writes nothing and spends nothing; it must not consume a live-spend guard.
3. **Re-derive the caps** — 2/day on a bid optimizer is decorative. Set caps from the rule's actual cadence and blast radius.

Then a one-off purge of the ~693k junk execution rows, and an alert if any rule's failure rate exceeds a threshold — this ran broken for months in silence, and that silence is the deeper defect.
**Exit met — verified on prod 2026-08-04:**

| Phase (same UTC day) | DRY_RUN | FAILED | new CAP_EXCEEDED |
|---|---|---|---|
| Before deploy | 642 | **17,308** | — |
| After deploy | 26 | **0** | **0** |

The 96.4% waste is gone and rules execute cleanly for the first time.

**Follow-up now measurable — the caps are still wrong.** With the ratchet fixed, the evaluator's own summary reads `evals=298 matches=201` every tick, ~96 ticks/day. 201 rules match every 15 minutes against caps of 2–5, so the overwhelming majority are still refused — correctly and silently now, rather than by writing a rejection row. Item 3 of this phase (re-derive the caps from cadence × blast radius) was deliberately deferred until this number existed. It now does. Each tick takes ~204s, comfortably inside the 15-minute cadence.

### ADX.2 — Repair the propose pipeline ✅ **SHIPPED 2026-08-04**
**Diagnosed:** suggestion generation was gated on `rule.actions[0].control === 'manual'`, a flag only the rule-builder UI sets. Measured on prod: **all 51 advertising rules carry `control = <none>`**, and the only 2 `AdsRuleSuggestion` rows in existence came from two throwaway rules named `__ea manual 178196…` during EA3 development in June. The Propose pipeline had never produced a suggestion from a real rule.

Dry-run and Propose were conflated: `rule.dryRun` yields an execution row you'd have to go looking for, while the reviewable artifact sat behind a flag nothing in production sets. A dry-run rule was invisible by construction.

**Fixed:** any advertising rule that matches and executes in dry-run now proposes. Volume is bounded by the existing upsert on `(ruleId, entityId, proposedKey)` — a recurring 15-min tick refreshes one row rather than piling up duplicates — and `generateSuggestionsFromExecution` already drops non-actionable results (failed / noChange / skipped / noActiveWindow).

Excluded: the "test rule" endpoint, via a new explicit `isTestRun` flag. **Not** excluded: `forceDryRun`, which the cron sets account-wide when autonomy is `SUGGEST` — precisely when suggestions are the point.
**Exit met:** every dry-run match produces a reviewable suggestion. 6 regression tests.

### ADX.3 — Attribution *(read-only; narrower than originally scoped)*
`userId` already carries `automation:rank-defend-<id>`, so this is smaller than §1.10b assumed. Close the real gaps: **10,348 log rows with null attribution**, 2,386 tagged `user:anonymous`. Add the reasoning payload — metric, threshold, data window, sample size — so a write explains itself. Ship a unified change history filterable by source, entity and field.
**Exit:** every bid movement is explainable without reading code.

### ADX.4 — Exemption *(safety before power)*
Pins at any granularity — account, campaign, ad group, target, field — with optional expiry. Enforced at `ads-write-gate.ts`, the existing single chokepoint, so no engine can bypass it.
**Exit:** anything you care about can be protected from every engine.

### ADX.5 — Authority *(prerequisite for live rules, not an emergency)*
Contention measured at 3.3% of fields and 0 events within 1h — because only rank-defend actually writes. **That changes the moment ADX.1 lands and 36 rules start acting.** One owner per field; declared precedence `operator-pin > event override > rank schedule > rule > optimizer > default`; a lower-authority engine raises a suggestion instead of writing.
**Gate:** must ship before any rule leaves dry-run.

### ADX.6 — The Control Console + Foresight
`/marketing/ads/autopilot` becomes the one place autonomy is seen and steered, built on ADX.1–5. Every lever as a row: mode (Off/Observe/Propose/Auto), authority, scope, caps, accountability strip (applied this week · last run · enabled since · net effect), revert. Wire the **existing** `autonomy/status` · `pause-all` · `resume` · `automation/state` endpoints, plus write-gate controls and manual cron triggers. Add **Foresight**: next-24-hours across all engines, and a 30-day dry-run diff before enabling any lever.
**Exit:** you can see what every automation did, will do, and would have done — and change any of it without a deploy.

### ADX.7 — Fix what's broken before turning anything up
CPC ceilings on the 13 uncapped all-out schedules; drain the ~2.5k dead letters; surface `coverage.daysWithData` wherever an AMS-derived ratio is shown so thin-data schedules can't mislead.
**Exit:** no known-unsafe automation remains armed.

### ADX.8 — Light up measurement *(read-only)*
Turn on TOS-IS ingest, SQP ingest, structural reconcile. Build the STIS/STIR scheduled-console-report ingest for the impression-share data the API won't give. Ship the Coverage scoreboard as a tab on Analytics — per keyword: our impression share, our rank against the field, which of our ASINs cover it. `share-of-voice` is already wired, so this is partly a port.
**Exit:** you can see exactly how much of page one you own, per keyword, per hour.

### ADX.9 — Graduate the existing rules to Propose
Move the ~30 template rules from dry-run into Propose against real data. Review the suggestion stream for two weeks. Tune conditions where proposals are wrong.
**Exit:** a suggestion feed whose proposals are consistently right.

### ADX.10 — SERP coverage engine *(the original ask)*
Use the `lanes` field that already exists: drive Top + Rest-of-Search + Product-pages simultaneously. Add the **bid ladder** — one ASIN bid for Top of Search, the rest bid to fill Rest-of-Search rows — so a shared keyword set yields several page-one appearances instead of several ASINs fighting for one slot. Add self-ASIN targeting to hold your own detail pages. Turn on `ads-tos-defense.job` behind a scope allowlist.
**Exit:** measurable multi-slot coverage on the shared keyword set, with cost per page-one appearance tracked.

### ADX.11 — Ad-type stacking *(the biggest missing lever)*
Build create + optimize paths for **Sponsored Brands**, **SB Video**, and **Sponsored Display** — currently read-only in `ads-api-client.ts`. Separate inventory pools, so they stack on the same page without competing with your SP bids. Evaluate Amazon's native Performance+ / Brand+ / Ads Agent as complements. DSP and audiences already have legacy UI and endpoints to build on.
**Exit:** one query can hold SB banner + SBV + multiple SP slots + SD.

### ADX.12 — Autonomy
Promote proven levers from Propose to Auto, one at a time, each with its own caps and scope. Add the supervisor: a daily budget/pacing envelope, an anomaly guard that trips to Observe on a spend or ACOS excursion, and a morning digest of what ran overnight.
**Exit:** the account runs unattended, with the digest as the only routine touchpoint.

### ADX.13 — Retire legacy
Redirect `/marketing/advertising/*` and `/marketing/ads-console/*` into `/marketing/ads/*`. Delete only after traffic is confirmed zero.
**Exit:** one console.

---

## Part 6 — Open questions for the gate

1. **Does the diagnosis match your experience?** §1.10 argues control was lost to missing authority/attribution/exemption, not to missing features. ADX.0 tests this against your data by measuring how often two engines moved the same bid. If the conflict rate comes back near zero, the diagnosis is wrong and ADX.1–4 should be re-scoped — worth knowing before building on it. If it's high, that single number is the justification for the whole plan.
2. **Autonomy appetite** — is the target "Auto for bids and budgets, Propose for structural changes (new campaigns, negatives, pauses)", or Auto for everything within caps?
3. **Economic envelope** — a monthly spend ceiling and a target blended ACOS/TACOS for the supervisor to pace against.
4. **Coverage vs efficiency** — on the shared keyword set, is the objective page-one *coverage* (accept higher ACOS for slot count) or *profit* (accept fewer slots)? ADX.10's ladder is tuned very differently for each.
5. **SB/SBV creative** — SB needs brand creative and SBV needs video. Is that asset work in scope, or does ADX.11 stop at SD plus SB using existing product imagery?
6. **Variation structure** — do we run the ADX.8 experiment on whether two children of one parent can co-occupy a SERP? It decides whether AIREON's unified parent is costing coverage. Measurement only; no re-split proposed.

---

## Sources

- [Best Amazon PPC Automation Tools 2026 — SalesDuo](https://salesduo.com/blog/amazon-ppc-automation-tools/)
- [Pacvue — Retail Media Ad Management](https://pacvue.com/retail-media-ad-management/)
- [Pacvue — Dayparting with Share of Voice data](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Pacvue vs Perpetua — Atom11](https://www.atom11.co/blog/pacvue-vs-perpetua)
- [Amazon — Search term impression share report for Sponsored Products](https://advertising.amazon.com/resources/whats-new/search-term-impression-report-sponsored-products)
- [Intentwise — Measuring Search Term Impression Share](https://www.intentwise.com/foundation/data-store/amazon-ads/sponsored-products-search-term-impression-share-report)
- [Amazon Ads — Sponsored Products and Sponsored Brands prompts (unBoxed 2025)](https://advertising.amazon.com/en-us/resources/whats-new/unboxed-2025-sponsored-products-and-sponsored-brands-prompts/)
- [Amazon Ads unBoxed 2025 recap — Flywheel](https://www.flywheeldigital.com/blog/amazon-unboxed-2025-ai-full-funnel-recap)
- [Amazon Ads Optimization & Automation 2026 Guide — MBAdv](https://www.mbadv.agency/amazon-ads/amazon-ads-optimization-and-automation)
