# ER3.4 — Products (`/ebay/products`) + Change Log (D4, new page)

Mini-spec per Part VIII (double gate). Sources: CURRENT-STATE-CRITIQUE §2.5 (Low-Medium —
"the newest and closest to right"), D4 (Change Log rail entry — "nearly free; parity
demands it"), H10 teardown verdict "Change Log incl. external-change source → **adopt**
(ER3 Products slot)": every mutation filterable by Change Type AND **Change Source**
(auto / operator / external) — our `CampaignAction` + drift-accept flow already classify;
only the page is missing.

**Ground truth** (verified 2026-07-03):

- `EbayProductsRollup.tsx` (181 lines): one grid of listings grouped by product; Match/
  cost flows verified live. The **promoted-state column does not exist** in the current
  build (despite the file header) — a listing shows nothing about whether/where it is
  promoted. Group-band label for unmatched carries a full teaching sentence. "Match…" /
  "match first" / "add cost" render as pill-shaped buttons. Date control is a preset
  `<select>` in the toolbar. No ROAS column.
- `GET /ebay-ads/actions` exists (channel=EBAY, entityId + before-cursor + limit ≤ 200) —
  consumed only by the per-campaign Activity tab; returns raw rows: no campaign-name
  resolution, no action-type filter, no source classification.
- `CampaignAction.userId` carries the real operator id for human actions and
  `automation:ebay-ads` for rule/guard actions; drift-Accept stamps
  `payloadAfter._mode='accept'`; live/sandbox rides `payloadAfter._mode`.
- The eBay rail is `EBAY_ADS_NAV` in `_shell/nav.ts` — a separate array from the Amazon
  `ADS_NAV`; adding an entry cannot touch Amazon.
- ER3.3 shipped `initialFilters` on AdsDataGrid — reusable here for deep links.
- The campaign Activity tab has a small payload-diff renderer (~91-line file) worth
  extracting rather than duplicating.

## The 10 deltas

### Products (7)

**1 · Band prose → tips.** The unmatched band label becomes just "Unmatched listings";
its teaching sentence moves to the State column tip and the Match state filter tip. Band
labels are names, not paragraphs.

**2 · Buttons look like buttons.** "Match…", "match first", "add cost" switch from
pill-shaped elements to small real buttons (`h10-am-btn sm`) — same click behaviour,
Amazon-idiom affordance. Matched state stays a pill (it *is* a state).

**3 · NEW Promoted column.** Per listing: which active campaigns carry it — chips with
the campaign's strategy badge, deep-linking to the campaign page; "—" when unpromoted.
API (additive): each listing row in `GET /products` gains
`campaigns: [{ id, name, fundingModel, adHidden }]` from its non-stale `EbayAd` rows.

**4 · Inventory state on the Qty column.** Qty 0 renders an **OOS** badge; any carrying
ad with `hiddenReason` adds a "hidden by eBay" badge (tooltip: eBay auto-hides ads for
out-of-stock listings; they resurface on restock). Data rides delta 3's `adHidden`.

**5 · Unmatched band stays last + deep-link entry (decision).** Recommendation: keep the
band last — matched groups sorted by spend are the operating set; unmatched is a triage
queue already surfaced by the dashboard Recommendations row. Instead of reordering:
support `?state=UNMATCHED` via `initialFilters` (ER3.3 prop) and point the dashboard
"Match products" CTA at it, so the triage path lands pre-filtered.

**6 · DateRangePicker (D1).** The toolbar preset `<select>` becomes the shared
DateRangePicker (exactly as the Ad Manager, ER3.1). Fetch layer already accepts ranges.

**7 · ROAS column (C8).** Ad sales ÷ ad fees with a proper total, after eBay ACOS —
column parity with the ER3.1 Ad Manager grid.

### Change Log (3)

**8 · Rail entry + route.** `EBAY_ADS_NAV` gains "Change Log" (`ebay/change-log`,
History icon) between Rules & Automation and Weekly Digest. eBay array only — the Amazon
rail is a different constant.

**9 · The page.** `ebay/change-log/` (folder-per-page): AdsDataGrid over the audit
trail — **When** · **Source** (pill: `automation` = rule/guard actor · `operator` =
human id · `external (accepted)` = drift-Accept rows — the H10 change-source idiom,
honest to our data) · **Action** (type label) · **Target** (campaign name deep-linked;
listing/keyword ref when present) · **Change** (payload diff — the Activity tab's
renderer extracted to `ebay/_lib/changes.tsx` and reused by BOTH surfaces, no behaviour
change to the campaign tab) · **Result** (SUCCESS/FAILED + live/sandbox pill) ·
rolled-back marker. Filters: Source · Action type (from the loaded set) + grid search;
"Load older" uses the existing `before` cursor (200/page). Freshness line = newest row.

**10 · API (additive).** `GET /ebay-ads/actions` gains: `campaignName` per row (batch
lookup by externalCampaignId), derived `source` field (classification above), and
optional `actionType` query filter. Existing consumers (Activity tab) unaffected —
fields are additive, default behaviour unchanged. **No migration.**

## Non-negotiables honoured

- **Amazon untouched** — nav change is in the eBay-only array; no shared component edits
  planned (initialFilters already exists). Amazon rail + Ad Manager snapshot anyway.
- **No fake data** — Promoted chips/hidden badges come from live ad rows; Change Log
  renders the immutable audit trail verbatim (source derived from recorded actors, never
  guessed).
- **Guarded writes only** — both surfaces are read-only except the existing Match/Cost/
  Promote flows, which are untouched.
- Reversible: single revert, no migration.

## Verification script (gate 2)

Smoke (`_er34-smoke.mts`): /products rows carry `campaigns[]` cross-checked against
EbayAd rows (incl. an adHidden case if present); /actions rows carry campaignName +
source with counts per class cross-checked against userId/_mode queries; actionType
filter narrows; before-cursor pages. Prod click-through: Promoted chips deep-link;
OOS/hidden badges; ?state=UNMATCHED deep link from the dashboard CTA; DateRangePicker
drives metrics; ROAS totals; Change Log renders real history (E5 live-validation rows
exist) with Source pills + campaign links + Load older; campaign Activity tab unchanged
after the renderer extraction. Amazon rail + Ad Manager before/after identical. Builds +
`tsc` green.

## Rollback

Single revert (no migration; nav entry and endpoints are additive).
