# ER2 SPEC — Campaign Builder v2 (`/marketing/ads/ebay/campaigns/new`)
<!-- ER0 deliverable 4b. Companion reading: AMAZON-PATTERN-LANGUAGE.md §PL-7 (chooser + SPW
     stepper contract), COMPETITOR-TEARDOWN.md (Teikametrics review-gate, Rithum rate verdicts),
     CURRENT-STATE-CRITIQUE.md B-1…B-8. Approval gate before any build. -->

## 1. Purpose

Replace the goal-first single-screen builder with the Amazon paradigm: a **type-card chooser** (strategy cards) → **per-type stepper wizards** (§PL-7 anatomy), with the former goal presets demoted to an optional **"Start from a template"** row. Every piece of v1 machinery survives behind the new chrome (critique §4 keep-list): per-listing break-even rates, conflict resolution, keyword seeds, budget provenance, preflight blocking/advisory, readiness score, rule-pack binding, launch timeline + per-item results.

## 2. Entry — the type-card chooser (C5)

Route `/ebay/campaigns/new` renders the chooser (mirrors `CampaignBuilder.tsx`, §PL-7: `.h10-cb` chrome, `.h10-cb-top` title + "Exit Builder" → eBay Ad Manager, `.h10-cb-panel`):

- **Section "Marketplace"** — the eBay market chip selector (replaces Amazon's profile select; same `.h10-cb-profile-btn` idiom with the eBay mark + flag).
- **Section "Campaign type"** — `.h10-cb-cards` grid, card = `{title, Icon, bestFor, desc}`:
  1. **General (CPS)** — *Best for:* always-on coverage with zero-risk fees. *Desc:* pay a % of the sale only when an ad leads to one; any-click attribution means most sales carry the fee — margin discipline is the whole game. Works on auctions too.
  2. **Priority — Manual (CPC)** — *Best for:* owning specific searches. *Desc:* keyword bids + ad groups; the ONLY strategy eligible for the first ad slot in search (exclusive on IT/FR/ES/UK since Jun 2025, US since Jan 2026 — teardown §6 #2). Pay per click; fixed-price listings only.
  3. **Priority — Smart (CPC)** — *Best for:* CPC reach without keyword management. *Desc:* eBay targets under your max CPC cap.
  4. **Offsite (CPC)** — *Best for:* external reach (Google/social). Card state per §6.4 (creation support is verified at build; if the write layer doesn't support it yet, the card is present but routes to an honest explainer + Seller Hub link — never a dead flow).
  - `EBAY_ES`: both Priority cards render disabled with the stated reason (Priority unavailable in Spain) — the correct surface for the v1 goal-card restriction (B-8).
- **Row "Start from a template"** (unobtrusive, below the cards): Protect margin · Push hero · Clear stock · Defend visibility — chips, not cards. Picking one routes to the matching type's wizard with the template's pre-fills applied (GOAL_DEFS mapping retained server-side); every pre-fill is editable; a template is never a gate. **Protect margin upgrades in v2**: it pre-selects General → *rules-based* targeting with an all-inventory criterion + auto-select-future-listings ON (a TRUE catch-all that enrolls future listings by itself — beats v1's static key-based version; the coverage guard demotes to safety net).

## 3. The stepper shell (per §PL-7 SpSuperWizard contract)

One shared `_wizard/` shell consumed by all type folders: `.h10-spw-*` chrome verbatim — `header.h10-spw-top` (eyebrow "Nexus Ads · eBay", h1 "Campaign Builder : {Type}", exit link), `nav.h10-spw-steps` (`.circ` number + label, `.on/.done`, connector lines), footer `.h10-spw-foot` (Back · `.grow` · `.h10-spw-err` · Next/Launch primary). State lifted into the per-type wizard component (§PL-7 idiom); derived plan recomputed `useMemo` on inputs. **Navigation policy** (reconciling Amazon's freely-clickable steps with the mandate that steps validate): visited steps are freely clickable; advancing past a step with *blocking* issues opens the Amazon-style warning modal (§PL-7) — but unlike Amazon it does NOT offer "continue anyway" for **launch-blocking** items (empty CPS listing set, invalid rates, unresolved conflicts, budget < €1); advisory items (missing cost, sprawl, over-BE) warn-and-allow with the acknowledge checklist surfacing again at Review. Launch stays disabled until blockers are zero (v1 preflight semantics preserved).

## 4. File architecture (C1)

```
ebay/campaigns/new/
  page.tsx                     thin → chooser
  EbayCampaignChooser.tsx      type cards + template row (replaces EbayCampaignBuilder.tsx)
  _wizard/
    WizardShell.tsx            stepper chrome (steps nav, footer, error slot)
    plan.ts                    CampaignPlan type + derive/validate helpers (ONE plan object, all types)
    draft.ts                   draft persistence (§7)
    steps/                     shared step components (SetupStep, ProductsStep, RatesStep pieces,
                               KeywordsStep, ReviewStep, CriterionBuilder, RateDiscoveryPanel)
  general/GeneralWizard.tsx        + page.tsx (route: new/general)
  priority-manual/PriorityManualWizard.tsx + page.tsx
  priority-smart/PrioritySmartWizard.tsx   + page.tsx
  offsite/OffsiteWizard.tsx                + page.tsx   (or explainer per §6.4 verification)
```
Per-type wizards declare `STEPS` arrays and compose shared step components — the wizard files stay thin like `SpSuperWizard.tsx` (§PL-7). `builder-icons.tsx`-style icons for the four cards (reuse Amazon's icon file conventions; new eBay icons only where no fit exists).

## 5. Steps per type (machinery mapping in parentheses)

**General (CPS)** — ① Setup ② Targeting ③ Listings ④ Rates ⑤ Review & Launch
**Priority manual** — ① Setup ② Structure ③ Listings ④ Keywords & Bids ⑤ Budget ⑥ Review & Launch
**Priority smart** — ① Setup ② Max CPC ③ Listings ④ Budget ⑤ Review & Launch
**Offsite** — ① Setup ② Budget ③ Review & Launch (gated §6.4)

### ① Setup (all types)
Marketplace (locked from chooser, changeable here with a re-derive warning) · campaign name — **name-grammar assist**: the generated `{goal|type}-{strategy}-{scope}-{mkt}-{seq}` name renders as a one-click suggestion chip next to a free input (editable always; grammar never forced) · schedule: start (default now) / optional end date (template Clear-stock pre-fills +30d).

### ② Targeting / Structure (type-specific)
- **GEN**: choice cards — **Key-based** (pick listings in step ③) vs **Rules-based**: the **CriterionBuilder** — selection rules (dimension: brand / category / condition / price band · values from live index facets; the "≤10 rules" cap is third-party-reported only, verified at build — teardown §6 #6), **auto-select-future-listings toggle** (eBay re-evaluates matches daily), and a **live matching preview** (count + 5 sample listings via the shared criterion-preview endpoint, SPEC-campaign-detail §7). Rules-based skips step ③ (the preview IS the listing set) and step ④ offers the campaign-level rate + strategy (fixed % or DYNAMIC ± adjustment capped by `adRateCapPercent` — the one CPS shape where campaign-level rate is real and mutable, teardown §6 #3). (Write layer already supports criterion campaigns — v1 never exposed it; critique B-4.)
- **PRI manual**: ad-group structure — v2 ships **single-group default** ("Default" pre-named, renameable) + "Add ad group" for more; per-group name + default bid (`money`). (Multi-group scaffolds à la SPW structure schemes are a deliberate non-goal until eBay campaigns here outgrow one group — deviation §11.2.)
- **PRI smart**: `maxCpc` input with **Suggest** button (`suggestMaxCpc` passthrough; quota-governed) + explainer of what smart does/doesn't allow (no keywords; on-site only).

### ③ Listings (product-first — GEN key-based, PRI both)
The v1 picker upgraded to a two-panel ProductsStep (§PL-7 ProductSelection anatomy): left = live listings grouped by product (search + facets, match-state chips, price/qty), right = staged selection. Per-listing rows carry break-even (or "add cost" chip deep-linking to Products page in a new tab) and the **conflict state** (one-listing-one-General) with the v1 resolution select (skip / move here / include-will-fail) — machinery unchanged. **PRI wizards additionally flag out-of-stock listings** (eBay rejects OOS listings on Priority campaigns at creation — teardown §6 #8; qty=0 rows render excluded with the reason). Quick actions: "All live listings" (catch-all key-based), "All unpromoted". Selection count + trailing-30d sales total in the panel footer.

### ④ Rates / Bids / Budget (the economics step)
- **GEN key-based**: the v1 per-listing rate table, re-chromed: computed rate (BE × goal factor when a template set one, else fallback) · rate source provenance chip · per-row override input (red when > BE) · **eBay suggested/trending rate beside every input where the API provides it** (verified: Recommendation API `bidPercentages` ITEM+TRENDING on **AU/DE/GB/US only** — teardown §6 #12; IT/FR/ES render "n/a — eBay exposes no suggested rate for this market" with our break-even rate as the anchor; honesty required, no fabricated numbers) · projected monthly fee footer (trailing sales × rate).
- **Rate Discovery panel (GEN, per-campaign opt-in)** — our answer to Rithum's Discover Rate, anchored where theirs isn't: floor % + cap % (cap hard-clamped to per-listing break-even by the engine), step size, dwell window (days) → creates an `EbayRateDiscoveryPlan` at launch. The cron walks rates within bounds per dwell window, measures attributed fees/sales, and emits **PROPOSE** proposals per step (AUTO only under posture Auto); progress + best-so-far render in the campaign's Automation tab (ER1 surface). v2 scope = bounded ladder with dwell windows; multi-armed refinements later. New machinery flagged for its own tests at the build gate.
- **PRI manual — Keywords & Bids**: the v1 seed panel re-chromed per §PL-8 KeywordTargetingPanel *pattern* (tabs: **Mined seeds** (titles+aspects, source badges — v1 generator) / **Enter keywords** / *(later: My lists)*), match type per keyword, per-keyword bid with **Suggested bid** column (`suggestBids` passthrough) beside break-even-CPC when computable · negatives basket (advanced link) · assignment to ad groups (single-group case: implicit).
- **PRI budgets**: daily budget with the v1 provenance formula line + an **eBay Suggested budget** button (`suggestBudget` passthrough — verified to exist, teardown §6 #11) + the 15-edits/day note and the 2×-daily / 30.4×-monthly spend semantics stated (teardown §5); `money()` everywhere.

### ⑤ Review & Launch (the Teikametrics-verdict transparency step)
Full derived-plan review, **edit-in-place**: campaign card (name/schedule/strategy — click edits return to the step, state preserved) · listings table with final rates (inline-editable here too) · keywords + bids table (PRI) · criterion summary + preview count (rules-based) · rule packs to bind (v1 checkboxes) · Rate Discovery summary if armed · **structural-gap flags** (ad group with 0 keywords; listing set empty; budget missing — each with a jump-to-fix link, per the Teika preview verdict) · the acknowledge-advisory checklist (missing cost, over-BE with **OverrideReasonModal** replacing `window.prompt`, sprawl ≥25) · readiness score with its fix list · **Launch** → v1 result screen preserved (per-item promote/keyword results + "what happens next" timeline + open-campaign CTA).

## 6. Additional contracts

1. **Prefill API**: v1 `POST /builder/prefill` splits into composable calls the steps own — listings+economics+conflicts (step ③ data), seeds (step ④, PRI), budget suggestion (step ④) — same underlying services, additive routes only; `POST /builder/launch` gains `criterion` + `adGroups[]` + `rateDiscovery` fields (additive).
2. **Templates**: server-side GOAL_DEFS stays authoritative; `GET /builder/templates` returns the four templates as pre-fill payloads so chooser chips stay in sync with rule-pack definitions.
3. **ES gating** at chooser (§2); sprawl advisory (≥25 running) at Review (v1 logic).
4. **Offsite**: build begins with a write-layer verification (createCampaign OFF_SITE channel support). Supported → 3-step wizard above. Not yet → card routes to an explainer panel (what Offsite is, what Seller Hub offers, "creation lands in a later phase") — honest, no dead ends. Decision recorded at the ER2 build gate.
5. **No regression window**: chooser + wizards land as new routes (`new/general` etc.); `new` swaps from v1 plan-screen to chooser atomically at the approved gate (D7).

## 7. Draft persistence (leave & resume)

`draft.ts`: serialize the CampaignPlan to `localStorage` keyed `ebay-builder-draft:<type>:<marketplace>` (+ `version` field; incompatible versions discarded) on every step commit; on chooser/wizard entry with a live draft → resume banner ("Resume where you left off · started {when} · {type} on {mkt}") with Resume / Discard. Client-only by design: single-operator console, no cross-device need yet; server drafts are a recorded later option (ER4 proposals) — justification per C1 "as the approved spec defines".

## 8. Component-reuse table

| Component | Status | Note |
|---|---|---|
| `.h10-cb-*` chooser chrome + card anatomy | shared classes, new eBay component | Amazon's `CampaignBuilder.tsx` is Amazon-routed; the eBay chooser reuses its classes + card shape verbatim (no fork of behavior to import) |
| `.h10-spw-*` stepper chrome | shared classes via new `_wizard/WizardShell` | SPW's stepper markup generalized; SpSuperWizard itself untouched (protocol: copy/generalize, never modify Amazon) |
| `DateRangePicker` / `AdsPageHeader` | not used here | builder uses `.h10-cb`/`.h10-spw` chrome like Amazon's builders |
| ProductsStep | new (justified) | eBay listing-grain picker with break-even + conflict columns — no Amazon equivalent carries economics |
| CriterionBuilder | new (justified) | eBay-only concept (selection rules); shared with ER1 Details "clone with edited rules" |
| KeywordsStep | new, pattern-ported | §PL-8 KeywordTargetingPanel *pattern* (tabs + basket), eBay data (seeds/suggested bids/BE-CPC); the Amazon component itself is SP-domain |
| RateDiscoveryPanel | new (justified) | no equivalent anywhere (our beat-item vs Rithum) |
| OverrideReasonModal, QuotaMeter, StatusPill, `money()` | shared with ER1 | single implementations |
| Review tables | AdsDataGrid where tabular | C2 applies inside Review (listings/keywords tables render through the grid with edit fields) |

## 9. States

Each step owns skeletons for its data loads (`.h10-cd-skel` idiom); step-level inline error + Retry; empty states with actions (Listings step, nothing live: "No live listings on {mkt} — discovery runs every 4h" + link to Products). Draft-resume banner. Launch failure: per-item results with retry guidance (v1 behavior). No layout shift: tables reserve column widths; suggested-rate/bid cells render placeholders while loading. Every money value through `money()` with currency; freshness line on the listings step (index `lastSeenAt`).

## 10. C1–C14 conformance checklist

C1 ✓ §4 (folder-per-type, shared `_wizard/`, thin pages) · C2 ✓ Review tables via AdsDataGrid (§8) · C3 n/a (detail spec) · C4 n/a · C5 ✓ chooser cards + per-type folders + stepper + templates-as-row (§2–4) · C6 ✓ no date UI in builder (schedule fields only; consistent `{start,end}` types) · C7 ✓ `money()` (§5④, §9) · C8 ✓ `_lib/types.ts` mapping reused · C9 ✓ StatusPill in review/conflict chips · C10 ✓ `.h10-cb`/`.h10-spw` classes reused; any new class justified at build gate · C11 n/a · C12 ✓ freshness on listings step · C13 ✓ ER2 headers · C14 ✓ additive `/api/ebay-ads` routes only (§6.1).

## 11. Deviations from the Amazon pattern (with reasons)

1. **Templates row** has no Amazon equivalent — it preserves the Owner-approved margin-first presets as accelerators without gating (the Teikametrics verdict: goals as durable pre-fills, not forced first screens).
2. **No multi-campaign scaffolds** (SPW's Standard-5/Advanced-11) — eBay's two live strategies don't decompose into match-type campaign families; one campaign per launch is the honest eBay shape. Revisit if fan-out (#19) activates.
3. **Blocking validation is stricter than SPW's warn-and-continue** — eBay launches spend real money through per-item writes; v1's blocking preflight semantics are contractual (Part VII: destructive/spend-affecting actions confirm).
4. **Rate Discovery** exists nowhere in the Amazon console — eBay-only machinery anchored to the economics engine.
5. **Chooser lives at `new`** (Amazon's chooser is `campaign-builder/`) — route continuity for the existing eBay console; label parity ("Campaign Builder") kept in the chrome.

## 12. Build-gate verification script (preview)

All four cards route (ES: Priority cards disabled with reason) · template chip pre-fills General rules-based with auto-select ON + editable everywhere · GEN key-based: conflict select round-trips (skip/move/include), over-BE input turns red, override reason collected via modal, launch → per-item results + timeline · GEN rules-based: criterion preview count matches index query; launched campaign shows structured criterion in ER1 Details · PRI manual: seeds render with source badges, suggested bids populate, group negatives land, launch creates group+keywords (sandbox first) · draft: leave mid-wizard, return → resume banner → state intact; discard clears · readiness + acknowledge parity with v1 · Rate Discovery: plan row created, first cron tick emits a PROPOSE proposal within bounds (sandbox) · zero `window.prompt` anywhere · Amazon builder pages before/after identical.
