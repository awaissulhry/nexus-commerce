# AX3 — Replication as a campaign builder: audit, research, and phases

> Proposal, 2026-07-29. Scope: `/marketing/ads/blueprints` (AX2.4/2.5/2.10) → a first-class
> **Replicate Structure** builder alongside Quick / Guided / SP Super Wizard / Single.
> Evidence: source audit + two read-only production probes
> (`apps/api/scripts/_bp-source-probe.mts`, `_bp-fidelity-probe.mts`). No writes, no Amazon calls.

---

## 1. What exists today, and how it is wired

Five files, one page, nine routes. The model is **two objects**: a saved `AdBlueprint`, and an
`AdBlueprintApplication` recording each time one was applied.

| Layer | File | Job |
|---|---|---|
| Pure extract/diff | `ads-core/ads-blueprint.ts` | Live campaigns → a product-agnostic `BlueprintDoc`; classify every target BRAND / CATEGORY / COMPETITOR / ASIN; emit `sharedTargets`; diff a doc against a live set |
| Pure plan/gate | `ads-core/ads-blueprint-apply.ts` | Materialise `{{product}}` → the target token; detect keyword collisions with what we already run; produce `blockers` / `warnings` / `allowed` |
| DB adapter (read) | `advertising/ads-blueprint.service.ts` | `loadSourceCampaigns` by `campaignIds` **or** `namePrefix`; save/list/diff |
| DB adapter (write) | `advertising/ads-blueprint-apply.service.ts` | `marketContext`, `planApply`, `applyBlueprint`, `rollbackApplication` |
| Surface | `app/marketing/ads/blueprints/BlueprintsClient.tsx` | 389 lines: capture form, blueprint table, replicate panel, conflict table, history |

**Purpose it serves.** One good campaign structure (the 11-campaign `IT-AIREON-SP-*` portfolio:
Auto · Brand/Competitor/Category × Broad/Phrase/Exact · PAT) is captured with everything
product-specific parameterised out, then re-created for the next jacket without rebuilding it by
hand — with one thing the naive "duplicate" cannot do: **it refuses to let two of your own products
bid on the same keyword.** `sharedTargets` (positive CATEGORY + COMPETITOR terms) is a blocking
gate; you must Skip or Accept each collision by name. Amazon runs a second-price auction, so two
Xavia jackets on `giacca moto` raise Xavia's own clearing price and split one pool of demand. That
gate is the most valuable thing in the feature and it must survive every change below.

**Safety model, all of it real:** dry-run is the default; a non-`allowed` plan cannot execute;
creation goes through the gated `ads-create.service`; each run is one rollback unit; after creating
we read back and report `PARTIAL` when a campaign never got an Amazon id.

---

## 2. What production actually looks like

```
active campaigns                    190   (IT 125 · DE 33 · FR 22 · ES 10)
carrying a portfolioId               62   (33%)  — membership IS synced from Amazon v3
AmazonAdsPortfolio rows              10
matching the IT-TOKEN-SP-Role name   11 / 190
```

Nine portfolios hold live campaigns, in **five different naming conventions**:

| Portfolio | Campaigns | Example name |
|---|---|---|
| IT AIREON | 11 | `IT-AIREON-SP-Auto` |
| Xavia GALE IT | 11 | `GALE \| IT \| Phrase \| Competitor` |
| IT_Gale | 9 | `IT_BMM_Gale`, `IT_Auto_Close` |
| Moss_Jacket | 7 | `Auto_Loose_Moss` |
| DE_Gale / FR_Gale / ES_Gale | 6 each | `DE_Auto_Substitute` |
| Auto_FBM_Gale_Misano_Moss | 3 | `IT_Auto_Loose_Gale_Misano_Moss` |
| Misano_Jacket | 3 | `BMM_Misano` |

Depth of the one clean portfolio: **11 campaigns · 11 ad groups · 137 positives · 204 negatives ·
440 product ads**, every campaign carrying a `PLACEMENT_TOP +75%` modifier.

---

## 3. Defects found — measured, not inferred

Ordered by what they cost. These multiply the moment replication becomes one click, which is why
they are Phase 0.

| # | Defect | Evidence | Consequence |
|---|---|---|---|
| **G1** | **Role derivation only parses one convention.** `deriveRole` strips a 2-letter prefix and an `sp\|sb\|sd` marker, splitting on `[-_\s]+` | **11 of 190** campaigns match. `GALE \| IT \| Phrase \| Competitor` → role `\|-IT-\|-Phrase-\|-Competitor` | Capture from 8 of 9 portfolios produces garbage roles, garbage diffs, garbage replica names |
| **G2** | **Name collision.** `materialise` returns the source name unchanged when the name contains no product token | `IT_Auto_Close` (Moss portfolio) has no token | Replication creates a **second campaign with an identical name**. Nothing blocks it |
| **G3** | **`targetingType` is never captured or set.** `loadSourceCampaigns` doesn't select it; `createCampaignLocal` is called without it → defaults `MANUAL` | Column is populated: **AUTO=36 · MANUAL=140** | An Auto campaign replicates as a **manual** campaign |
| **G4** | **Auto targeting is dropped.** The 4 auto groups are `kind='AUTO'` rows — and locally their `expressionValue` is **empty**, so we don't even store which group | 141 AUTO rows, all blank values. Apply counts them in `skippedNonKeyword` and drops them | The replicated Auto campaign has **no targeting at all** — inert, never spends, never discovers |
| **G5** | **PAT / product targets are dropped.** Same `kind !== 'KEYWORD'` branch | **613** positive PRODUCT targets live | The PAT campaign shell is created **empty**. Documented in the runbook as "add those by hand" |
| **G6** | **`placementBidding` is captured and silently discarded.** The doc carries it; `applyBlueprint` never calls `updatePlacementBidding` | Every AIREON campaign: `PLACEMENT_TOP +75%` | Replicas lose the top-of-search bias that makes the source structure work |
| **G7** | **`portfolioId` is never set** on created campaigns (SPW's launch passes it; this path doesn't) | — | Replicas land outside every portfolio — invisible to portfolio budgets and rollups |
| **G8** | **`liveBidWritesEnabled` is never stamped.** SPW allowlists each campaign the instant it exists | Gate enforces it for `updatePlacementBidding` and `pushCampaignStructure` | Replicas are excluded from rank-defend / autopilot / ToS-defense bid writes, unlike every SPW campaign |
| **G9** | **Nothing is editable before launch.** No rename, no drop a campaign / ad group / keyword, no bid or budget change | The whole surface is capture → preview → launch | All-or-nothing. The operator's only lever is Skip/Accept per conflict |
| **G10** | **You cannot select a source by portfolio**, even though membership is synced | `CampaignSelector` = `campaignIds \| namePrefix` | The user's mental model ("pick a portfolio") is unreachable |
| **G11** | **ASINs are a free-text box.** Space/comma-separated, unvalidated | `asins.split(/[\s,]+/)` | Typos create campaigns advertising nothing. Every other builder uses the shared product picker |
| **G12** | **Bids and budgets copy verbatim.** A matured bid applied to a product with no history | Only control is a total €/day cap | Overspend on day one, or a structure that never wins an impression |
| **G13** | **No re-run guard.** Nothing detects that this blueprint already produced campaigns for this product | `AdBlueprintApplication` rows exist but aren't consulted | Applying twice silently doubles the structure |
| **G14** | **Saved blueprints have no detail view**; the **diff endpoint has no UI at all** | `POST /blueprints/:id/diff` is unreachable from the product | You approve a structure you cannot inspect |

---

## 4. What comparable software does

| Product | Pattern worth taking |
|---|---|
| **[Amazon Ads — Copy campaign](https://advertising.amazon.com/help/GPFGH67KMNLQ5TKU)** | Copy creates a **draft**, prepopulated; a dialog lets you name it and **choose which settings and targeting to copy**. [Cross-type copy](https://advertising.amazon.com/resources/whats-new/campaign-copy) reuses an SP campaign's schedule/budget/creative for SB or SD | → a "what to copy" checklist + a resumable **Draft** state |
| **[Google Ads copy/paste](https://support.google.com/google-ads/answer/9471263?hl=en)** + [Ads Editor](https://support.google.com/google-ads/editor/answer/38654?hl=en) | Copy/paste at every level; **find & replace** across a selection; [bulk edits](https://support.google.com/google-ads/answer/7485984?hl=en); an offline editor with review-before-post | → find & replace in the rename step; an editable tree; nothing reaches Amazon until you approve |
| **[Pacvue](https://pacvue.com/blog/how-to-optimize-amazon-dsp-campaigns/) / [Helium 10 Ads](https://revenuegeeks.com/helium-10-ads/)** | Pre-built campaign **tactics/templates** and guided setup as the primary onboarding path | → the saved-blueprint library is this; seed it from the account's own best structure |
| **[Sellozo](https://www.sellozo.com/post/unarchiving-and-cloning-ad-campaigns-on-amazon)** | Clone (and unarchive-then-clone) as a first-class action on the campaign row | → offer "Replicate this" from the Ad Manager row menu, not only from the builder |
| **[Karooya duplicate-keyword report](https://www.karooya.com/blog/new-feature-duplicate-keywords-report-for-amazon-ads/)** | Self-competition is a recognised product category — but shipped as a *report* | Nexus already has the stronger version (a **blocking gate**). Keep it; also expose it standalone later |

The gap none of them close, and we already do: **they let you clone into self-competition.** That
stays our differentiator — the plan below never weakens the gate, it only makes it inline and
per-keyword instead of a separate table.

---

## 5. Target design

### 5.1 Where it lives

The sidebar item goes. **Replicate Structure** becomes the 6th card on the Campaign Builder
type-chooser (`CampaignBuilder.tsx`), next to AI Goal · Quick · Guided · SP Super Wizard · Single —
which is where campaigns are created and where the operator already looks.

- New route `/marketing/ads/campaign-builder/replicate`
- `/marketing/ads/blueprints` → permanent redirect (bookmarks and the runbook keep working)
- `Blueprints` removed from `ADS_NAV` in `_shell/nav.ts`
- Saved structures, replication history and rollback move **inside** the wizard (§5.2, step 1 and 3)

### 5.2 The wizard — SP Super Wizard chrome, three steps

Identical shell to `SpSuperWizard.tsx`: eyebrow + title + Exit Builder, a 3-step stepper, a sticky
scroll-spy sub-nav on step 1, a Back/Next footer. Same `h10-spw-*` CSS block in `ads.css` — no new
design language, no new stylesheet.

**Step 1 — Source & Products** (sub-nav sections, in order)

1. **Source structure** — a **checkbox tree: portfolio → campaign → ad group**, with
   campaign/ad-group/keyword/negative counts and €/day on every row. Tick a whole portfolio, or
   cherry-pick individual campaigns, or individual ad groups within a campaign. A saved blueprint
   is a fourth entry point into the same tree.

   This granularity is not a nicety. **128 of 190 live campaigns belong to no portfolio at all**,
   and the richest product-targeting structures — `GALE JACKET PRODUCT TARGETING` and its siblings,
   154 product targets between them — are among them. A portfolio-only picker cannot reach the best
   material in the account.

   Selecting an ad group replicates its parent campaign shell plus that ad group only; Amazon has
   no ad group without a campaign. Keyword-level cherry-picking is deliberately *not* here — it
   belongs in step 2, where every keyword is visible and deletable in context.
2. **What to copy** — checklist, Amazon's pattern: keywords · negatives · product targets · auto
   groups · bids · budgets · placement modifiers. Unchecked means not created, and it says so.
3. **Naming** — the bulk rename the operator asked for: product-token swap (`AIREON` → `VENTRA`),
   prefix/suffix, and find & replace, with a **live old → new table for every campaign** and a hard
   stop on any name that collides with a live campaign (G2).
4. **Product Selection** — the shared `ProductSelection` component, unchanged, exactly as SP Super
   Wizard and Single use it. Replaces the ASIN text box (G11).
5. **Destination** — target market, destination portfolio via the shared `PortfolioPicker`
   (including Create portfolio), daily-budget cap, and the bid/budget policy: copy verbatim ·
   scale by % · set a flat value (G12).

**Step 2 — Review & Edit** — the step the operator described.

The materialised structure as an editable tree: **campaign → ad group → keywords / negatives /
product targets / auto groups**. Delete at every level. Inline rename, bid and budget edit. A bulk
toolbar reusing `CampaignSetup`'s exact model (select all / by kind / by match type; rename; set
bid; set budget; adjust bid %; clear keywords/negatives; delete). Keyword-level add/remove through
the shared `TargetingModal`. **Conflicts appear inline on the offending keyword** with Skip/Accept —
not in a separate table — because that is where the decision is actually made.

Skippable: "Looks right, continue" moves straight to step 3.

**Step 3 — Preflight & Launch**

Totals, blockers, warnings, the conflict ledger, €/day against the cap, market writability, and a
recap of everything that will *not* be copied. Then Launch → result panel (created counts,
`notOnAmazon`, errors) → one-click rollback. Plus **Save as blueprint** and **Export as bulksheet**
(the existing `/marketing/ads/bulk` round-trip as the escape hatch).

### 5.3 Shared components reused verbatim

`ProductSelection` · `PortfolioPicker` · `TargetingModal` · `PlacementBidMultiplier` · `H10Select` ·
DS `Modal` / `Button` / `Input` / `Radio` / `Textarea` · the `h10-spw-*` chrome. New CSS is limited
to the source-picker rows and the tree indent, appended to the existing `ads.css` block.

---

## 6. Phases

Each is independently shippable and verifiable on production. Order is deliberate: the engine tells
the truth before a one-click surface multiplies what it gets wrong.

### ✅ AX3.0 — Fidelity: make apply create what it captured *(no UI)* — SHIPPED 2026-07-29 `620ae445c`
G2, G3, G4, G5, G6, G7, G8. Captures `targetingType` and normalises the auto clause across all three
spellings it appears in; creates Auto campaigns as `AUTO` with their clauses, PRODUCT/CATEGORY
targets, and negative product targets; applies `placementBidding`; passes `portfolioId`; stamps
`liveBidWritesEnabled`; blocks a name that collides with the destination market **or with the plan
itself**. 22 new unit tests (68 total across the two suites).

**Verified on live data** via `scripts/_bp-fidelity-verify.mts` across all five source shapes —
**241 targets recovered** that were previously created and silently dropped:

| Source | Recovered | Notes |
|---|---|---|
| IT AIREON | 4 | the 4 auto clauses; 11/11 placement modifiers now applied |
| IT_Gale | 28 | 12 auto + 16 product. Collision gate correctly **blocks** `IT_Auto_Close`, `IT_Auto_Loose`, `IT_Auto_Substitute` |
| Xavia GALE IT | 23 | pipe convention; roles still ugly (`\|-IT-\|-Auto`) → AX3.1 |
| Moss_Jacket | 22 | 4 of 7 campaigns are AUTO |
| GALE product-targeting (no portfolio) | **164** | previously 100% dropped. Also caught a **self**-collision: two campaigns whose names differ only in case |

### AX3.1 — Source at any grain, and roles that survive five conventions
G1, G10, plus the approved extension. `CampaignSelector` gains `portfolioId` **and `adGroupIds`**, so
a source can be a portfolio, a hand-picked set of campaigns, or individual ad groups within them.
`deriveRole` tokenises on `[-_|\s]+` so the pipe convention stops producing `|-IT-|-Auto`, falls back
to a *structural* label (targeting type + dominant match type + target class) when the name yields
nothing, and de-duplicates roles so two campaigns never collapse onto one in the diff.
New `GET /advertising/blueprints/sources` returns the portfolio → campaign → ad-group tree with
counts, including the unportfolio'd campaigns that a portfolio-only picker cannot reach.
Verified against all nine live portfolios and the unportfolio'd set.

### ✅ AX3.2 — The builder entry point — SHIPPED 2026-07-29 `0fc79c2d2`
Sixth card on `CampaignBuilder.tsx`; route `/marketing/ads/campaign-builder/replicate`; SPW chrome +
3-step stepper + Exit Builder + scroll-spy sub-nav. The source tree ships with it: portfolio →
campaign → ad group, tri-state selection held at ad-group grain, unportfolio'd campaigns in their
own group. **Verified on prod** — IT AIREON renders 11 campaigns with matching counts and the AUTO
tag on the Auto campaign.

The nav item and the old `/blueprints` page are deliberately still there. They come out in AX3.5,
when the new flow can do everything the old one can — moving the entrance before the room is built
is how you end up with two half-features.

### ✅ AX3.3 — Step 1 — SHIPPED 2026-07-29 `010695bf1`, `49a160a04`
What-to-copy checklist (Amazon's copy-dialog pattern, with the two toggles that change behaviour
rather than preference calling themselves out) · bulk rename — product-token swap, find-and-replace,
prefix/suffix — with **every old → new name on screen** and collisions flagged as you type · the
shared `ProductSelection` · destination market, `PortfolioPicker`, budget cap, and a bid/budget
policy (copy · scale % · flat, floored at Amazon's 2¢).

Naming, copy scope and the value policies are all `ApplyOptions` on the **pure planner**, not client
state, so the footer's totals/blockers/conflicts are the ones the launch will enforce. New read-only
`POST /advertising/blueprints/plan-preview` plans from a live source with no saved blueprint, so the
library does not fill with throwaway rows while someone types.

The product token is **guessed** from the selected names — the word appearing in most of them,
ignoring anything structural — because making the operator work it out from names they may not have
written is a poor opening move. Always overridable.

*Prod caught one defect during verification:* the picker filtered orphaned targets while the planner
deliberately keeps them, so `IT-AIREON-SP-Auto` read "0 keywords" while the plan created 4 auto
clauses. Fixed in `49a160a04`; the count is now "targets", which is what it actually is.

### ✅ AX3.4 — Step 2: the editable tree, client **and** server — SHIPPED 2026-07-29 `d82ca7d00`, `9ecc4a927`

**The contract.** The client never sends a plan. It sends the source selector plus an **edit set
addressed by plan id**, and the server rebuilds the plan from what is in the account right now,
replays the edits, and re-runs the entire gate over the result. The obvious design — let the client
edit the plan and post it back — would put the self-competition gate on the client's side of the
trust boundary, which is exactly backwards.

`planApplication` split into `buildPlanCampaigns` → `applyEdits` → `evaluatePlan`, so the blockers,
the budget cap and the name-collision check all see the *final* campaign set. Every node carries a
deterministic id (`c0.g1.t7`).

Three things that had to be right:
- **An added keyword is gated like a copied one.** A copied target inherits its class from the
  blueprint; an operator-typed one has none, so it is classified at evaluation time against the
  *target* product — its own brand term is free, anything else is gated. Otherwise "add a keyword"
  is a hole straight through the gate.
- **Stale edits block, never partially apply.** If the source changed after the edits were made,
  applying the ones that still resolve would create something nobody approved.
- **`plan-preview` returns both plans** — un-edited (what the tree renders, with stable ids so a
  removal stays addressable and restorable) and edited (the footer's totals, blockers, conflicts).
  One round trip, so the tree and the verdict cannot disagree.

Conflicts are inline on the offending keyword rather than in a separate table: you see the term, its
bid and the campaign it would fight at the moment you decide, and "Drop it" removes it in one click.

Schema (additive, applied by Railway prestart, **verified on prod**): `blueprintId` nullable, plus
`sourceSelector` / `options` / `edits` / `launchMode`, so a run replicated from a live source is
still a recorded, rollback-able unit and "why is this campaign called that" stays answerable.

### AX3.5 — Step 3: preflight, launch, result, rollback
Totals, blockers, warnings, conflict ledger, €/day vs cap, market writability, not-copied recap,
launch, result panel, rollback, Save as blueprint, Export as bulksheet.

### AX3.6 — Library, history, drafts, diff
Resumable **Draft** replications (Amazon's pattern); replication history + rollback inside the
wizard; blueprint detail view — see every campaign, ad group and keyword before you apply (G14);
rename/delete a blueprint; the drift **diff** UI, which today has an endpoint and no surface (G14);
re-run guard warning when this blueprint already produced campaigns for this product (G13);
"Replicate this" from the Ad Manager row menu (Sellozo's pattern).

### AX3.7 — Verification and hand-off
Live dry-run walkthrough on a real portfolio; one gated real replication verified in Seller Central;
DS-conformance pass against the pre-push ratchet; English-only UI check; rewrite
`AX2-REPLICATION-RUNBOOK.md`, which currently opens with "There is **no UI for blueprints yet**".

---

## 7. Decisions — settled 2026-07-29

1. **The saved-blueprint object stays, demoted.** The wizard is portfolio-first; "Save as blueprint"
   is an optional action at step 3. `AdBlueprint` and `AdBlueprintApplication` keep their schema and
   routes — nothing is deleted. This is what preserves re-use of a tuned structure across products
   and keeps the drift-**diff** audit alive (endpoint exists, surface lands in AX3.6).

2. **Launch state is chosen per run, on the launch step.** A two-way control, never a pause —
   honouring [[feedback_no_pause_use_low_bids]]:
   - **Go live now** — created `ENABLED` at the planned bids (today's behaviour).
   - **Land at floor bids (~€0.02)** — created `ENABLED`, so delivery, read-back and the sync spine
     all behave normally, but every keyword and auto-group bid is clamped to the floor so nothing
     meaningful spends until the operator raises them.

   **Default: floor bids**, because the preflight shows the €/day commitment right beside the
   control and the safe side should be the one you have to click away from. The choice is recorded
   on the `AdBlueprintApplication` row so a run can be explained later. Raising a floored run to its
   planned bids is a single bulk action from the result panel, and lands in AX3.5.

Not asked, decided: bid/budget policy ships as a UI control (copy · scale % · flat) rather than a
one-time choice; the old `/blueprints` route redirects rather than 404s; replication history lives
inside the wizard with a link from the Change Log.
