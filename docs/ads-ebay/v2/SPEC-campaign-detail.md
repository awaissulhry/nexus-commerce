# ER1 SPEC — Campaign Detail v2 (`/marketing/ads/ebay/campaigns/[id]`)
<!-- ER0 deliverable 4a. Companion reading: AMAZON-PATTERN-LANGUAGE.md (§PL refs),
     COMPETITOR-TEARDOWN.md (verdict refs), CURRENT-STATE-CRITIQUE.md (finding refs D-1…D-8, X1…X9).
     Nothing in this spec is built until the Owner approves it (ER gate 1 of 2). -->

## 1. Purpose

Rebuild the campaign detail page to Amazon's structural standard (§PL-4/§PL-5): a thin routed shell, one file per tab, one file per modal, an **editable Details surface**, a routed **ad-group drill-down**, and a **new per-campaign Automation tab** — strategy-aware throughout (capabilities absent on a strategy are absent, not greyed). All v1 machinery (guarded writes, break-even guardrails, budget quota meter, Activity log, freshness) is preserved behind the new structure; the keep-list in CURRENT-STATE-CRITIQUE §4 is contractual.

## 2. Routes & file architecture (C1, C4)

```
apps/web/src/app/marketing/ads/ebay/
  _lib/                            ← _shared.tsx dissolves here (ER1)
    types.ts        payload types + ONE metric-name mapping (D2/C8: acosPct→acos, avgCpcCents→cpc, +roas)
    fetch.ts        useEbayAdsFetch/postEbayAds/getEbayAds (gains startDate/endDate per D1)
    presets.ts      PRESETS (kept for compat + digest links)
    status.ts       eBay native→normalized mapping consumed via the shared StatusPill (C9)
    banners.tsx     SandboxBanner, freshness line helper
  _modals/                         ← cross-page modals from _write-modals.tsx (one file each)
    PromoteModal.tsx               (used by Products + detail Add-listings)
    ImportCsvModal.tsx             (Ad Manager)
    OverrideReasonModal.tsx        (NEW — replaces every window.prompt; used by detail + builder)
  campaigns/[id]/
    page.tsx                       thin (unchanged contract)
    EbayCampaignDetail.tsx         shell, target ≤190 lines (fetch → header → tab bar → body)
    tabs/
      DetailsTab.tsx               editable Settings v2 (§5.1)
      AdsTab.tsx                   (§5.2)
      AdGroupsTab.tsx              PRI-manual only (§5.3)
      KeywordsTab.tsx              campaign-level rollup (§5.5)
      NegativeKeywordsTab.tsx      "Campaign Negative Keywords" (§5.6)
      SearchTermsTab.tsx           data-gated (§5.7)
      AutomationTab.tsx            NEW (§5.7)
      ActivityTab.tsx              (§5.8)
    modals/
      AddKeywordsModal.tsx  AddNegativeKeywordsModal.tsx  CreateAdGroupModal.tsx
      CloneModal.tsx  EndCampaignModal.tsx  RemoveAdsModal.tsx
    ad-groups/[agId]/
      page.tsx
      EbayAdGroupDetail.tsx        drill-down shell (§6)
      tabs/  AdsTab.tsx  KeywordsTab.tsx  NegativeKeywordsTab.tsx  SearchTermsTab.tsx
```

**`_write-modals.tsx` dissolution map** (every current export → destination): `PromoteModal→_modals/`, `BudgetModal→**dissolved** into DetailsTab budget field (§5.1)`, `AddKeywordsModal/AddNegativesModal→[id]/modals/`, `ImportCsvModal→_modals/`, `CloneModal→[id]/modals/`, `MatchModal/CostModal→products/modals/` (moved verbatim; Products page import updates only), local `H10Modal` shim + `Err` + `ResultsList` → `_lib/modal.tsx` (pattern note: Amazon modal files each render their own chrome; we keep ONE shared shell — deviation §11.3). Nothing else may import `_write-modals.tsx` after ER1 (file deleted).

## 3. Header (§PL-1 CampaignDetailHeader — consumed as-is, no fork)

- `backLabel` "Back to eBay Ad Manager" → `/marketing/ads/ebay/campaigns` · `label` "Campaign Details" · `badge` = strategy chip: `GEN` / `PRI · manual` / `PRI · smart` / `OFF` (same `.pb` vocabulary as the Ad Manager grid) · `title` = campaign name (+ **Protected** pill when the automation policy has it, §5.8; + `nexus` pill when nexusManaged).
- **DateRangePicker (D1)**: real `{start,end}` state owned by the shell, passed to metric tabs; `showDateRange` only on grid tabs (Ads/Ad Groups/Keywords/Search Terms) exactly like Amazon (§PL-1). The v1 preset `<select>` in the Ads toolbar is removed.
- Right cluster: market chip must render the **eBay** brand mark (fixes X2 — the account cluster currently hardcodes the amazon wordmark; the fix lands in the shared header consumed by both channels only if the component takes a `brand` prop today; otherwise a `channel?: 'amazon'|'ebay'` prop is ADDED additively, defaulting to amazon — zero Amazon-visible change, snapshot-verified).
- `actions[]`: Add listings (GEN, PRI-smart) · Add ad group (PRI-manual) · Clone · Pause/Resume (state-dependent) · End campaign (danger → EndCampaignModal). All existing endpoints; End confirms with consequences (X4 fix). ⚠ §PL-1 found the header renders `danger` menu items with **no CSS rule** — ER1 adds `.h10-menu button.danger` to ads.css (additive; styles a class Amazon already emits but never styled — visible only where a danger action exists).

## 4. Strategy-aware tab matrix (Part III, restated as the shell's single source)

```ts
// tabs.ts (in [id]/): declarative matrix — the shell renders from this, no inline booleans
GEN        Details · Ads · Automation · Activity
PRI manual Details · Ad Groups · Keywords · Campaign Negative Keywords · Search Terms · Automation · Activity
PRI smart  Details · Ads · Search Terms · Automation · Activity
OFF        Details · Ads(read-only grid, no rate edit — CPC is eBay-managed) · Automation · Activity
```
Search Terms is **Priority-only** — verified: `SEARCH_QUERY_PERFORMANCE_REPORT` (dims `search_query`/`campaign_id`/`ad_group_id`) exists for CPC campaigns and is explicitly unsupported for CPS (teardown §6 #10) — so GEN never shows the tab. Absent capabilities are **absent** — no disabled tabs. Default tab = Details (Amazon parity, §PL-4); `?tab=` routing idiom verbatim (default paramless, `router.replace`, back-friendly).

## 5. Tabs

### 5.1 DetailsTab — the editable surface (modeled on Amazon `DetailsTab`, §PL-5; fixes D-1/D-2)

**Anatomy = Amazon's verbatim (§PL-5):** `.h10-cd-cols` = sticky left scroll-spy subnav (200px; eBay section ids: `campaign · schedule · budget · bidding · targeting · danger`) + `.h10-cd-form` (max-width 1010px) of `.h10-cd-sec` sections (h2 + `.h10-cd-card.pad`). **Always-editable inputs, whole-form snapshot diff** (`dirty = JSON.stringify(form) !== baseline`), and the **always-rendered sticky footer** — "Discard Changes" + "Save Campaign" both disabled unless dirty, inline `span.msg` toast, save = fan-out of one guarded write per dirty field group, then reload (never optimistic). Field controls from the §PL-5 catalog (money box, end-date calendar, switches, radio cards). The section cards:

1. **Campaign** — name (inline rename; ≤80 chars; guarded write → new `updateCampaignIdentification`) · strategy summary sentence with the hard constraint stated verbatim: *"The ad rate lives on each ad — the campaign default applied at creation only. Change rates on the Ads tab."* (GEN) · marketplace (read-only chip) · external campaign id + **Open in Seller Hub** link · managed-by chip (Nexus / Seller Hub) · sandbox/live mode note (existing banner logic).
2. **Schedule** — start date (read-only once live) · end date (editable where eBay allows via `updateCampaignIdentification`; build-time doc verification; if rejected for a state, the error surfaces inline per §PL-5 validation idiom). Ended campaigns show the terminal notice + Clone CTA.
3. **Budget** (PRI/OFF only) — daily budget with inline edit; the **15-edits/day meter renders beside the field before any attempt** (existing `budgetUpdatesToday`); currency via `money()` (C7). This dissolves BudgetModal.
4. **Bidding / Rate strategy** (GEN) — FIXED vs DYNAMIC as structured fields (never JSON — fixes D-2): DYNAMIC shows `adRateCapPercent` as an editable bounded field (existing `updateRateStrategy` write) + Floor Watch note ("we alert if eBay drifts ads above this cap"). PRI-manual: bidding mode FIXED/DYNAMIC display + the eBay lock stated ("manual bid edits are disabled while DYNAMIC"). PRI-smart: `maxCpc` field (editable only if the API supports post-create update — ER1 build verifies; otherwise read-only + "set at creation; clone to change").
5. **Targeting** (rules-based GEN only) — the criterion rendered STRUCTURED: one row per selection rule (dimension · operator · values), auto-select-future-listings state, live **matching-listings count + 5-sample preview** (new preview endpoint §7). eBay makes selection rules immutable → the card's action is **"Clone with edited rules"** (opens Clone modal → ER2 builder criterion step pre-filled). No fake editability.
6. **Danger zone** — End campaign (EndCampaignModal: consequences stated — ads stop serving, ENDED is terminal, history retained, clone to relaunch).

Every edit passes the guarded write layer and lands in Activity (existing audit).

### 5.2 AdsTab (GEN, PRI-smart, OFF)

v1 grid preserved (AdsDataGrid + GridEditMode hover-pencil/bulk rate edit + break-even column + guardrail with named-reason override — the override reason now collected by `OverrideReasonModal`, X4 fix). Additions:
- **State column upgraded**: normalized ad status + **"Hidden — out of stock"** chip derived from `EbayAd.hiddenReason`/listing qty (schema already carries `hiddenReason`; payload gains it §7) — displayed as a state, never an error, with restock note.
- **Deep links** in the name cell: listing title → eBay item (existing) + **product link** → `/marketing/ads/ebay/products` highlighted row (uses `EbayAd.productId`, already in schema).
- Bulk remove → RemoveAdsModal (consequences: ad removal is reversible by re-promoting; frees the listing for another General campaign).
- OFF: grid renders read-only (no edit mode, no bulk) with an explainer line.

### 5.3 AdGroupsTab (PRI-manual)

Grid: group name · default bid (`money`) · keywords count · ads count · window metrics rolled up from keyword-grain facts (fees/clicks/impressions/sales via existing `EbayAdsDailyPerformance` keyword rows grouped by adGroupId). Row click → routed drill-down (§6). Toolbar: **+ Ad group** (CreateAdGroupModal, existing `createAdGroup` write). Pinned totals per grid idiom.

### 5.4 KeywordsTab (campaign-level rollup, PRI-manual)

v1 grid preserved (bid GridEditMode + enable/pause bulk). Changes: **Ad Group column becomes a link** to the drill-down (D-4) · new **Suggested bid** column loaded on demand via existing `suggestBidsApi` passthrough (§7), shown beside the bid input (`money`); DYNAMIC-bidding campaigns show the lock state on bid cells. Primary keyword management (add/negatives per group) lives in the drill-down; the campaign-level Add-keywords modal remains for the common one-group case (group preselected when only one exists).

### 5.5 NegativeKeywordsTab — label "Campaign Negative Keywords" (D5)

v1 preserved; match types **EXACT + PHRASE** (verified against the API reference, teardown §6 #5 — the master prompt's "exact-only" note was wrong; our write layer was already correct). Copy states "broad match is not supported by eBay". Campaign-level vs group-level negatives split honestly: this tab = `adGroupId == null` rows; group-level negatives live in the drill-down.

### 5.6 SearchTermsTab — Priority campaigns only (gate RESOLVED: buildable)

ER0 verified `SEARCH_QUERY_PERFORMANCE_REPORT` (teardown §6 #10): CPC-only, one campaign per task, under the 200/hr report quota — the report pipeline gains this type (per-campaign tasks scheduled for PRI campaigns with clicks; same chunking/parser infrastructure). Grid: search query · ad group · impressions · clicks · fees · sales · acos, with row actions **Add as keyword** (group + match type + bid prefilled from suggested bid) and **Add as negative** (EXACT/PHRASE, scope) — both through existing writes; multi-select feeds the same actions in bulk (the H10 SearchTermActionModal pattern, §PL-4). Header note: last 72h provisional (reconciliation period). This tab closes the harvest loop the automation rules already consume.

### 5.7 AutomationTab — NEW (fixes D-3)

Sections top-to-bottom:
1. **Policy card** — posture override: `Inherit (default) · Off · Suggest · Auto` (same button-group idiom as the hub dial) + **Protected** toggle ("excluded from ALL automation — rules, coverage guard, discovery"; renders the header badge + Ad Manager badge) + per-campaign guardrail overrides: rate cap/floor % (GEN) or bid cap/floor (PRI), each clamped by the economics engine (can never exceed break-even; clamp note shown). Storage: new `EbayCampaignAutomationPolicy` (§7 — the one migration of ER1).
2. **Rules that apply here** — global rules whose scope includes this campaign (or unscoped): name, enabled, mode, last-run line; each links to the hub. (Per-rule exclusion from here is deferred to the ER3 hub rebuild — noted as a deviation §11.4.)
3. **Pending proposals** scoped to this campaign — inline Approve/Reject (existing `decideProposals`).
4. **Applied** scoped — with timestamps + one-click Rollback (existing).
5. **Drift** scoped — existing `detectDrift(campaignId)` with Re-apply/Accept.
Data: one aggregate endpoint (§7). Enforcement (server side, same migration PR): evaluator skips `protected`/`posture=OFF` campaigns, downgrades to PROPOSE under `Suggest`, and `clampAutoRate` honors policy caps/floors after the break-even clamp; coverage guard skips `protected`.

### 5.8 ActivityTab

v1 preserved + additions: action-type filter (select), mode filter (live/sandbox), pagination (endpoint already takes `limit`; add `before` cursor), and rows that reference proposals link to the Automation tab. Copy unchanged (immutable, oldest at bottom).

## 6. Ad-group drill-down (NEW routes, C4; mirrors Amazon `AdGroupDetail` §PL-6)

`/ebay/campaigns/[id]/ad-groups/[agId]` — header: back link "Back to {campaign}", label "Ad Group", title = group name, default-bid inline edit (if `updateAdGroup` verified in build; else read-only + note), same DateRangePicker. Tabs (all existing grid idioms):
- **Ads** — listings in this group (`EbayAd.adGroupId` — column already in schema); add-listings modal scoped to the group.
- **Keywords** — THE primary keyword surface: bid GridEditMode + suggested-bid column + enable/pause bulk + Add keywords (group preset).
- **Negative Keywords** — group-level negatives (`adGroupId == agId`) + add modal.
- **Search Terms** — same gate as §5.6, filtered to the group.
Empty states per §PL-4 idiom (e.g., Keywords empty: "No keywords yet — seed from the listing titles" CTA opening AddKeywordsModal with mined seeds preloaded, reusing the builder's seed generator via API §7).

## 7. Data requirements — all additive (C14; the one migration called out)

| Item | Kind | Detail |
|---|---|---|
| `EbayCampaignAutomationPolicy` | **migration (reversible)** | `campaignId` unique FK · `posture` enum INHERIT/OFF/SUGGEST/AUTO (default INHERIT) · `protected` bool default false · `rateCapPct/rateFloorPct` Decimal? · `bidCapCents/bidFloorCents` Int? · audit stamps. Rollback = drop table. |
| `GET /ebay-ads/campaigns/:id/automation` | endpoint | `{policy, rules[], proposals[], applied[], drifts[]}` (composes existing services + `detectDrift(campaignId)`) |
| `PUT /ebay-ads/campaigns/:id/automation-policy` | endpoint | guarded (not an eBay write — local governance; still audited as `set_automation_policy`) |
| `updateCampaignIdentification` | write-service fn + endpoint | name/endDate via eBay `updateCampaignIdentification`; audited `update_campaign_identification`; gate/kill-switch like all writes |
| Ads payload | field adds | `hiddenReason`, `adGroupId`, `productId` (all in schema already) |
| Keywords payload | field adds | `adGroupId` (schema has it) |
| `GET /ebay-ads/campaigns/:id/keyword-bid-suggestions` | endpoint | passthrough to existing `suggestBidsApi`, quota-ledger governed |
| Criterion preview | endpoint | `POST /ebay-ads/criterion-preview {marketplace, rules[]}` → `{count, sample[5]}` computed from `EbayListingIndex` (shared with ER2 builder) |
| Search terms | report-pipeline extension + endpoint | `SEARCH_QUERY_PERFORMANCE_REPORT` tasks (PRI campaigns, per-campaign, quota-ledger governed) → facts table reuse → `GET /ebay-ads/campaigns/:id/search-terms` |
| Date params | additive | `startDate/endDate` accepted by detail/facts handlers (D1); presets remain |
| Actions cursor | additive | `before` param on `GET /ebay-ads/actions` |

Evaluator/guard changes (same PR as the migration): policy enforcement per §5.7.5. **No Amazon files touched**; header `channel` prop (if needed for X2) is additive with amazon default + before/after snapshot of an Amazon page.

## 8. Component-reuse table (C-contract proof)

| Component | Status | Note |
|---|---|---|
| `CampaignDetailHeader`, `DateRangePicker`, `AdsPageHeader` | shared, as-is | X2 may add optional `channel` prop (additive; Amazon default) |
| `AdsDataGrid` + `GridEditMode` + `InfoTip` + `_grid/format` | shared, as-is | `money(cents, currency)` added to format.ts if absent (C7) |
| StatusPill | **to-be-shared (C9)** | extracted from `EBAY_STATUS_PILL` + Amazon pill usage; consumed by both channels' eBay side first; Amazon adoption deferred to a future workstream per protocol |
| Modal shell | to-be-shared (eBay-local) | `_lib/modal.tsx` from the current shim — deviation §11.3 |
| QuotaMeter | new (justified) | the 15/day budget meter as a reusable atom (DetailsTab + anywhere quota-gated); no Amazon equivalent exists |
| CriterionSummary / CriterionRow | new (justified) | eBay-only concept (selection rules); structured display + preview |
| AutomationPolicyCard | new (justified) | eBay-only per-campaign governance (Amazon has no per-campaign policy concept in our console) |
| OverrideReasonModal | new (justified) | replaces `window.prompt`; eBay-only (margin override is an eBay-console concept) |
| EndCampaignModal / RemoveAdsModal | new (justified) | consequence-stating confirms per quality bar; replace `window.confirm` |

## 9. States & interaction details

Skeletons: `.h10-cd-skel` per tab on first load (§PL-4 idiom) — no layout shift on arrival (grid columns pre-sized). Errors: inline row + Retry (idiom verbatim). Empty states: `.h10-cd-empty` with per-tab copy (Ads GEN: "No ads — Add listings or let the coverage guard propose enrollment"; Ad Groups: "No ad groups — create one to add keywords"; Automation-proposals: "Nothing pending for this campaign"). Optimistic updates ONLY on: rename, policy toggles (cleanly reversible local state + rollback on error toast); rates/bids/budget stay reload-after-write (matching v1 write semantics). Every metric panel keeps its freshness line; every money cell renders through `money()` with payload currency; quota meters render before attempts.

## 10. C1–C14 conformance checklist

C1 ✓ §2 (folders, tabs/, modals/, _shared dissolved) · C2 ✓ all grids AdsDataGrid + format (§5) · C3 ✓ header/tabs/routing (§3–4) + skeleton/error/empty (§9) · C4 ✓ routed drill-down (§6) · C5 n/a (ER2) · C6 ✓ D1 picker + additive params (§3, §7) · C7 ✓ `money()` everywhere (§8–9) · C8 ✓ `_lib/types.ts` mapping (§2) · C9 ✓ StatusPill extraction (§8) · C10 ✓ no new `eb-*` (any exception listed at build gate with reason) · C11 ✓ D3 label lands with ER1 · C12 ✓ freshness kept (§9) · C13 ✓ ER1 headers on every file · C14 ✓ `/api/ebay-ads` only (§7).

## 11. Deviations from the Amazon pattern (each with its reason)

1. **Activity tab has no Amazon counterpart** — kept: the immutable audit log is an eBay-console governance feature the Owner already uses; Amazon may adopt it in a future convergence pass.
2. **Campaign-level Keywords rollup tab** (Amazon keeps keywords only under ad groups) — kept: real eBay PRI campaigns here typically hold one ad group; forcing a drill-down for the 1-group case adds a click for nothing. The drill-down is still the primary management surface.
3. **One shared modal shell** instead of per-modal chrome — less duplication; visually identical (`h10-modal-*` classes).
4. **Per-rule campaign exclusion** deferred to the ER3 hub rebuild — the Automation tab links to the hub instead (scope editing belongs to the rule editor).
5. **Details default tab** matches Amazon; v1's default (Ads) changes — called out so the Owner expects it.

## 12. Build-gate verification script (preview)

Prod click-through: open a GEN, PRI-manual, PRI-smart, OFF campaign → tab sets match §4 · rename + budget edit + end-date edit land in Activity with correct audit types · budget meter visible before edit · DYNAMIC prefs render structured (no JSON anywhere) · criterion card shows structured rules + live preview count · ad-group drill-down: keywords bid edit + suggested bids + group negatives · Protected toggle → badge in header + Ad Manager, evaluator skip verified by running an evaluation · scoped proposals approve/rollback round-trip · drift re-apply/accept scoped · OOS-hidden ad renders as state chip · zero `window.prompt/confirm` remain under `ebay/` · Amazon console before/after snapshots identical.
