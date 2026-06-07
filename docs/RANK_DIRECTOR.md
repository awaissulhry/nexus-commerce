# Rank Director — product-family, market-aware rank + dayparting control

Pick a **product** → see when its whole **variation family** actually sells (per
market) → assign **rank goals to time windows** (dayparting + rank fused) → **one
plan drives every campaign** advertising that family, holding the top slot during
your hours and reverting otherwise. Automatic within family guardrails, with a
manual override.

## How it maps to Amazon (the constraints)

- **Top-of-Search placement bidding is set at the _campaign_ level** (`Campaign.dynamicBidding.placementBidding[PLACEMENT_TOP]`, 0–900%), never per-ASIN. So "control a product's rank" = orchestrating **every campaign that advertises the family's ASINs**.
- A product is a **variation family** (parent `Product.isParent` + children via `parentId`; per-market ASINs via `ChannelListing`). Ads attribute per child ASIN; demand pools across the family → **data is family-level even for a one-ASIN campaign**.
- Amazon never exposes literal rank — only impression **share** (campaign-day, T+1) + weekly search-query share. "Hold rank" = hold a Top-of-Search impression-share target by bidding. The **"when do we sell" timing signal is order demand by hour** in the market's local time.

## Model — `ProductRankPlan` (one per product × market)

`packages/database/prisma/schema.prisma`. The single source of truth; family
membership is **resolved live** (`resolveProductFamily`), never stored (campaigns
join/leave; `AdProductAd.productId` is often null).

| field | meaning |
|---|---|
| `productId` / `parentAsin` | family anchor (parent Product) |
| `marketplace` | one plan per family per market |
| `windows` `[{days,startHour,endHour,targetKey}]` | fused dayparting + rank goal |
| `defaultTargetKey` | baseline ("for the rest, hold Y") |
| `timezone` | shopper-local enforcement TZ |
| `familyDailyBudgetCents` / `familyAcosCapPct` / `maxCampaigns` | family guardrails |
| `leadTimeMinutes` | pre-ramp before a window opens |
| `enabled` / `manualOnly` | armed / manual-only |
| `lastSummary` | last run's per-campaign decisions + conflicts |

## Engine — `apps/api/src/jobs/ad-rank-defend.job.ts`

`runRankDefendOnce` evaluates plans **before** standalone `AdSchedule`s and builds a
`governed` set so a plan always wins over a leftover per-campaign schedule
(precedence). Per plan:

1. `resolveProductFamily` → the family's campaigns (live).
2. **maxCampaigns guard** — resolve to more than the cap → refuse + auto-pause (mis-targeted).
3. **lead-time** — evaluate the active target at `now + leadTimeMinutes` (`resolveActiveTargetKey`).
4. **family guards** (`effectiveSpec` / `suppressRaise`): OOS / lost-buybox (`analyzeRetailReadiness`) → pause; over family daily budget → suppress raises; over family ACOS → drop all-out.
5. **self-competition** (`rank-self-competition.ts`): two of our campaigns on the same EXACT/PHRASE keyword (or two AUTO) → keep the best (lower ACOS), demote the rest to baseline.
6. Per campaign: `computeStep` → `setSearchPlacement` (gated, the same plumbing as schedules) — drives the **target's own placement** (Top for own-top/defend/all-out, Rest for rest-of-search) and zeroes the other search placement. Sandbox-safe; live only when the write-gate is open.

Cron self-gated on `NEXUS_ENABLE_RANK_DEFEND=1`. Auto-actuation skips `manualOnly`
plans; an explicit run-now (`force`) actuates them.

## Motion profiles (MP v2) — "Placement % is the bid"

`computeStep` (`rank-controller.ts`) is the one place a bid moves. The model the operator
chose: **Placement % (`biasPct`) is the bid the loop holds — it snaps to it, up or down, in
one cycle and holds. It only goes ABOVE Placement % when a Ceiling is raised above it.**
Per-`RankTarget`, overridable per product/campaign; the v2 defaults are regression-locked by
`rank-controller.vitest.test.ts`.

| Field | Meaning | Blank/default |
| --- | --- | --- |
| `biasPct` | **Placement %** — the bid the loop holds (the floor/anchor) | snap to it both ways |
| `stepUpPct` | **Climb step** — set ⇒ ramp UP `+N`/cyc to the floor (and the chase rate above it) | blank ⇒ **snap up** |
| `stepDownPct` | **Ease step** — set ⇒ ease DOWN `−N`/cyc to the floor (opposite of Climb) | blank ⇒ **snap down** |
| `maxBiasPct` | **Ceiling** — set ABOVE Placement % to allow climbing up to it | blank ⇒ **= Placement %** (never above) |
| `keepClimbing` | climb to the Ceiling on its own (no signal), bounded by Ceiling + ACOS | `false` (only climb when winning) |
| `jumpStartPct` | dormant — snap-to-Placement makes the old "opening jump" redundant | ignored |

Band = `[floor, ceiling]` where `floor = biasPct`, `ceiling = allOut ? (maxBiasPct ?? 900) :
(maxBiasPct ?? floor)`. **Reaching the floor** snaps by default (or Climb/Ease step). **Above
the floor** (only when `ceiling > floor`, or all-out): climb toward the ceiling — auto when
Amazon signals (IS short / ACOS headroom / loss) **or** always with `keepClimbing` — and ease
back toward the floor, never below it. **all-out** forces a 900 ceiling and pushes to it,
ignoring ACOS. So `Target IS` / `ACOS cap` only act when a Ceiling above Placement % is set.

Edited in the **✎ Edit targets → ▸ Motion** drawer, with one-click recipes — **Hold** (snap &
hold), **Gradual** (ramp ±15), **Chase** (climb to 300 when winning), **Push** (always climb
to 300). Built-ins ship with no Ceiling, so own-top/defend **snap to their Placement % and
hold** (100% / 50%); raise a Ceiling to opt a target back into rank-chasing.

## API (`apps/api/src/routes/advertising.routes.ts`)

- `GET/POST /advertising/rank-plans`, `GET/PATCH/DELETE /advertising/rank-plans/:id` — CRUD (POST 409 on dup per `@@unique`).
- `GET /advertising/rank-plans/:id/family` — the campaigns it drives + per-campaign **attribution health** (ASIN-matched vs `productId`-null) + readiness verdict.
- `GET /advertising/by-product/family-dayparting?productId=&marketplace=&from=&to=` — family demand by hour (blended, sparse-shrunk) + a recommended rank-window plan.
- `POST /advertising/rank-plans/:id/run-now?dryRun=` — preview (dry) or apply-now (live, force).
- `POST /advertising/rank-plans/:id/revert` — reset the family's bias to the baseline.
- `POST /advertising/rank-plans/:id/apply-across {targetKey|percentage}` — immediate bulk Top-of-Search set across the family.

## UI

Ads-console Rank cockpit → **By product** (`?mode=plan`). `RankDirectorPanel.tsx`:
product picker → family demand heatmap (`DemandHeatmap`) + "Use recommended
windows" → baseline + window editor → family guardrails → Save. Once saved: the
family campaign list (readiness + attribution + the loop's live decision), a
self-competition note, and controls — **Fully automatic** toggle, **Manual only**,
**Apply now**, **Revert all**.

## Arming a plan (the live step)

1. Author + **Save** the plan (stored, not yet acting).
2. Use **Apply now** (dry preview first via the campaign list) to make one controlled, gated push, OR
3. Flip **Fully automatic ON** — the cron then holds the plan across the family every 15 min, within the family guardrails.
4. **Revert all** resets the family to baseline at any time.

Safety: the write-gate (env `NEXUS_AMAZON_ADS_MODE=live` + connection `production` +
`writesEnabledAt` + per-campaign value/day caps) governs every live push; sandbox
markets stay local. `maxCampaigns` bounds the blast radius. Start with one product.

## Known limitations (v1)

- **Multi-market TZ / currency**: the demand SQL buckets `Europe/Rome` and counts EUR only — correct for **IT v1**; DE/FR/UK need the bucket TZ + multi-currency parameterised before they're trustworthy.
- **AUTO self-competition** depends on `AdGroup.targetingType='AUTO'` being synced; the keyword path (the dominant case) is unaffected.
- **Hourly ads (AMS)** is dormant on prod, so order demand is the primary timing signal and the RS.6 loss proxy simply never trips (conservative) — hourly-ads is a future overlay, not a dependency.
