# ER0 — Current-State Critique: eBay Ads Console v1
<!-- ER0 deliverable 3. Method: code inventory (verified 2026-07-03) + full click-through
     of production (Vercel) with screenshots on 2026-07-03. Written first-hand: the same
     session built E3–E7 and ran the visual verification pass, so this critique names
     causes, not just symptoms. Line numbers refer to commit cb857bd6. -->

## 0. Verdict in one paragraph

The v1 eBay console has the right **bones** (real data, guarded writes, audit, freshness, break-even awareness — no competitor has that substrate) wearing the wrong **skeleton**: five of seven pages are single-file monoliths that *borrow* the Amazon console's classes without adopting its architecture (folder-per-page, file-per-tab, file-per-modal, routed hierarchy, editable Details surface, stepper builder). The result reads ~80% visually similar and ~40% structurally similar. The Owner's dissatisfaction concentrates exactly where structure matters most: the campaign detail page (read-only settings, flat hierarchy, no automation view) and the builder (a goal-first bet that inverted the Amazon chooser+stepper idiom the Owner prefers).

## 1. Cross-cutting findings (fix once, benefits every page)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| X1 | **Monolith files vs folder idiom** — all tabs inline in `useMemo`s; five modals in one file; types+fetch+presets+banners in one `_shared.tsx` | `EbayCampaignDetail.tsx` 372L, `EbayCampaignBuilder.tsx` 374L, `_write-modals.tsx` 485L (7 modals now), `_shared.tsx` 215L vs Amazon `CampaignDetail.tsx` 176L + 8 `tabs/` files | High — blocks every structural upgrade |
| X2 | **Amazon brand mark renders on eBay pages** — the header market selector shows the *amazon* wordmark next to the eBay market flag on every eBay page | Prod screenshots 2026-07-03: header chip reads `amazon ▓ EBAY_IT` on dashboard/detail/builder (`AdsPageHeader`/`CampaignDetailHeader` account cluster) | High — visible cross-channel identity bug, Owner-facing |
| X3 | **Date paradigm split** — preset strings (`'last30'`) via `useEbayAdsFetch(path, market, preset)`; the detail header's `DateRangePicker` is stubbed with dummy props; the working preset `<select>` hides inside the Ads-tab toolbar | `EbayCampaignDetail.tsx:48–49,265`; `_shared.tsx` `PRESETS` | High (D1) |
| X4 | **Native browser dialogs in write paths** — `window.confirm` for End campaign (2 pages) and bulk ad removal; `window.prompt` for the break-even override reason at builder launch | grep: `EbayCampaignsGrid.tsx:76`, `EbayCampaignDetail.tsx:88,196`, `EbayCampaignBuilder.tsx:139` | High — violates the quality bar ("destructive actions confirm with consequences stated"); ugliest single interaction in the console |
| X5 | **Duplicate formatter sets** — eBay `_shared.tsx` exports `eurC/pctP/intlN` while the console standard is `_grid/format` `eur/int/pct`; both are used, `€` is hardcoded in `eurC` and in `actionSummary()` | `_shared.tsx`, `EbayCampaignDetail.tsx` (actionSummary) | Medium (C7) |
| X6 | **Metric-name split** — `ctrPct/acosPct/avgCpcCents` in payloads and UI vs Amazon `acos/roas/ctr/cpc` | `_shared.tsx` `Derived` | Medium (D2/C8) |
| X7 | **Nav drift** — eBay rail says "Automation", Amazon says "Rules & Automation"; eBay rail (5 entries) has no Change Log / Settings counterparts although `/api/ebay-ads/actions` (global log) already exists | `_shell/nav.ts` | Medium (D3/D4) |
| X8 | **`eb-*` CSS dialect** — 81 lines; small, but several classes duplicate near-identical `h10-*` styling (`.eb-panel`≈`.h10-cd-card`, `.eb-chip`≈`.h10-pill`, `.h10-cd-input` shim lives in ebay.css) | `ebay/ebay.css` | Low-Medium (C10 audit) |
| X9 | **No route-flagged rollout mechanism** — v1 pages were replaced in place; ER1/ER2 need an atomic-replace or flag decision per gate | — | Process |

## 2. Page-by-page

### 2.1 Campaign detail — `/ebay/campaigns/[id]` (Owner-dissatisfied; ER1 target)

**Keep (genuinely good):** `CampaignDetailHeader` + `.h10-cd-tabs` + `?tab=` routing already in place; Ads tab inline hover-pencil + bulk rate edit through the guarded write layer with per-item results; break-even column beside rates; budget 15/day meter exists; Activity tab (immutable event log with live/sandbox + success/failed pills) — verified rendering the full E5 live-validation history on prod.

**Findings:**
| # | Finding | Severity |
|---|---|---|
| D-1 | **Settings is a read-only card**, not Amazon's editable `DetailsTab`: no rename, no schedule edit, no criterion editor; budget edit is a detour through a modal | High — the #1 named dissatisfaction |
| D-2 | **Raw JSON shown to the Owner**: `campaignCriterion` and `dynamicAdRatePrefs` render as `JSON.stringify(...)` inside `<code>` | High — worst visual moment in the console (`EbayCampaignDetail.tsx:305,309`) |
| D-3 | **No per-campaign Automation view** — which rules touch this campaign, its proposals/applied/drift live only in the global hub; no posture override, no Protected flag | High (ER1 new tab) |
| D-4 | **Hierarchy flattened** — PRI keywords render as one flat grid with an "Ad Group" *text column* (`:156`); no ad-group drill-down pages (Amazon: routed `[agId]` pages); Add-keywords modal asks you to pick a group from a dropdown instead | High |
| D-5 | **No Search Terms tab** (harvest loop has no surface); no strategy-aware absence — OFF campaigns still show an Ads tab with "Add listings" they can't use meaningfully | Medium |
| D-6 | Date preset select buried in the Ads-tab grid toolbar; header shows no range control (stub props passed to satisfy `CampaignDetailHeader`) | Medium (X3) |
| D-7 | No deep links: ad rows don't link to the Products page row or the eBay listing; Activity entries don't link to proposals | Low-Medium |
| D-8 | Tab labels diverge from Amazon vocabulary ("Negative Keywords" vs "Campaign Negative Keywords"; no "Details" tab concept) | Low (D5) |

### 2.2 Campaign builder — `/ebay/campaigns/new` (Owner-dissatisfied; ER2 target)

**Keep:** everything *behind* the chrome — prefill economics (per-listing break-even × goal factor), conflict detection + skip/move/include, keyword seeds mined from titles+aspects, budget suggestion with formula provenance, preflight blocking-vs-advisory with acknowledge, readiness score, launch timeline + per-item results, rule-pack binding at birth. This machinery is the moat; ER2 re-chromes it.

**Findings:**
| # | Finding | Severity |
|---|---|---|
| B-1 | **Paradigm mismatch**: goal-first (4 goal cards → one dense plan screen) vs the Amazon type-card chooser (strategy cards) + per-type stepper the Owner explicitly prefers | High — the page's premise |
| B-2 | **One giant plan screen** mixes naming, budget, packs, a listings table, a keywords table, preflight and launch into a single scroll — no step validation, no progressive disclosure | High |
| B-3 | `window.prompt` for the override reason at launch (X4) | High |
| B-4 | **No rules-based (criterion) campaign creation** — key-based only; criterion campaigns can only enter Nexus via clone. eBay's auto-select-future-listings (the true "catch-all") is unreachable | High — capability gap, not just UX |
| B-5 | **No draft persistence** — leave the page, lose the plan | Medium |
| B-6 | No Priority-smart flow distinctions surfaced (`maxCpc`/`suggestMaxCpc` exist in API layer but the builder treats smart as a targeting dropdown) ; no Offsite flow at all | Medium |
| B-7 | No suggested bids for keywords (API wrapper `suggestBidsApi` exists, unused in builder); no eBay suggested/trending rate display (unavailable for IT via API — must be *stated*, currently silent) | Medium |
| B-8 | ES restriction shown as disabled goal cards with a pill — correct fact, wrong surface (belongs on strategy cards) | Low |

### 2.3 Dashboard — `/ebay`

**Keep:** 7 KPI tiles with deltas; fees-vs-sales chart; missing-cost banner; coverage KPI (85% 17/20, amber); freshness lines; Alerts card fed by live anomaly detection.
**Findings:** Status card is a raw key/value dump (uppercase status keys, mixed content — counts + coverage + attribution + timestamps in one flex row) · no Recommendations surface (Teikametrics-style hub is an ER3 candidate) · no budget-pacing or spend-vs-ceiling visual (ceiling exists in Automation only) · chart has no metric toggles or bars (Amazon `PerformanceGraph` supports more) · date control is preset-only (X3) · Alerts card has no link-through to the drifted/anomalous entity · KPI tiles lack sparklines. Severity: Medium overall — the page is honest but thin.

### 2.4 Ad Manager — `/ebay/campaigns`

**Keep:** the grid itself (AdsDataGrid, totals, filters, search, customize, CSV import with dry-run diff); GEN/PRI/OFF badges; hover-reveal Open; status chevron menu; per-row market chips.
**Findings:** **two export buttons render side by side** ("Export Data" + "Export Data…" — toolbarRight duplicate of the grid built-in; prod screenshot) · "Rate / Budget" column mixes three vocabularies (`per-ad · dyn`, `2%`, `€30.00/day`) with no tooltip explaining which applies · `nexus` pill unexplained (no tooltip/legend) · no automation column (which campaigns have rules bound / Protected flag — ER1 dependency) · no inventory-aware state (ads auto-hidden by OOS are invisible here) · status menu offers Enable/Pause/End but not Clone/Budget (the detail page has them; the grid forces a navigation) · Import/Export live on this page only (fine) but Export ignores current filters (exports all). Severity: Medium.

### 2.5 Products — `/ebay/products`

**Keep:** listing-grain grid grouped by product; Match… flow with scored suggestions (verified: slider listing → exact family top-3); add-cost inline flow with instant break-even echo; per-row Open + Promote; bulk Promote; the one-row-per-listing totals fix (2d384af6) reconciles this page with Ad Manager to the cent.
**Findings:** group-band labels carry instructional prose ("Unmatched listings — Match to a catalog product to unlock costs & break-evens (spend still counted)") — teaching text belongs in a tip, not a band · "Match…"/"match first" pills double as buttons (pill-as-button is not an Amazon idiom; works, but reads as a tag) · no promoted-state → campaign deep link (state pill says promoted but not *where*) · no inventory state column (qty exists; OOS-hidden-ad state doesn't) · unmatched band always sorts last even when it's the actionable set (should it lead when non-empty? ER3 question). Severity: Low-Medium — this page is the newest and closest to right.

### 2.6 Automation hub — `/ebay/automation`

**Keep:** posture dial + ceiling + halt semantics; 6 starter rules with per-rule enable + PROPOSE↔AUTOPILOT; Approvals grid with bulk decide; Applied with one-click rollback; Drift tab (Re-apply/Accept) — all verified live.
**Findings:** **rules are opaque** — a row shows name + mode + last-run counts but the trigger/action/guardrails are invisible and uneditable (no rule editor exists; the starter pack is take-it-or-leave-it) — the biggest capability gap vs Pacvue-class tools (condition stacking, benchmark selection) · posture card crams dial + ceiling input + ceiling chips + halt button into one flex row (screenshot: cramped at 1459px) · Approvals rows lack campaign deep links and any "why" beyond one clamp note · Applied list has no date filter/pagination and shows no timestamps · digest-adjacent surfaces (weekly digest CTA) absent here · no per-campaign scoping view (mirrors D-3). Severity: High for the missing rule editor, Medium for the rest.

### 2.7 Weekly Digest — `/ebay/digest`

**Keep:** the one-page week review concept; money + movers + autopilot + awaiting-decision + anomalies + missing-cost; Generate now; Mark reviewed; now pure h10 idiom (cb857bd6).
**Findings:** latest-week only (no week picker/history although `EbayAdsDigest` rows persist) · list aesthetics are plain `eb-results` bars — fine, but movers deserve mini-metrics alignment (columns) · "Awaiting your decision" items don't deep-link to the specific proposal (only to the hub) · digest is IT-hardcoded in header market chip. Severity: Low.

## 3. Root causes (why v1 looks like this)

1. **E6.1 was a reskin-in-place**: the Amazon *classes* were imported into the existing single-file pages; the Amazon *architecture* (folders, tabs-as-files, routed drill-downs, editable Details) was not. Every page inherited its pre-E6.1 file shape.
2. **Writes arrived as modals** (E4) bolted onto read-only pages (E3) — so "Settings" stayed a summary card and edits scattered into `_write-modals.tsx` instead of an editable Details surface.
3. **The builder was a deliberate goal-first bet** (E7 blueprint items 1–3), optimizing decisions-per-launch over structural familiarity. The Owner has now chosen the Amazon chooser+stepper idiom; the bet is reversed, the machinery survives.
4. **Strategy differences were under-modeled in UI**: tabs key off `fundingModel`/`targetingType` booleans inline (`isCps`, `isManualCpc`) rather than a declared strategy→capability matrix, so PRI hierarchy (ad groups) flattened and OFF shows inapplicable affordances.
5. **The eBay pages never got a design review pass of their own** — E6.1/E6.2 fixed what the Owner saw and named; nobody walked every state of every page against the Amazon console side by side (ER4 institutionalizes exactly that).

## 4. What must NOT regress in ER1/ER2 (the keep-list, consolidated)

Guarded write layer semantics (margin guardrail + named override + kill switch + audit) · break-even beside every rate/bid input · 15/day budget meter *before* edit attempts · freshness lines + any-click labeling · Activity immutable log · conflict resolution (skip/move/include) · keyword seeds + budget provenance · preflight blocking/advisory + readiness · launch timeline + per-item honesty · Match/cost flows on Products · coverage guard + Drift surfaces · CSV import dry-run diff.
