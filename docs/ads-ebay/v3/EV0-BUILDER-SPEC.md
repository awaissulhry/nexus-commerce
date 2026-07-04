# EV0 — Builder specs: the listing picker + the advanced-settings gap map

Companion to EV0-AUDIT.md. Everything here is evidence-verified (Amazon builder census +
eBay sync/service reads), nothing invented.

## 1 · The listing picker (EV2)

### Reference anatomy (Amazon `ProductSelection.tsx` + `.h10-spw-ps-*` in shared ads.css)
Two-panel grid (1.5fr/1fr, one 12px-radius frame): LEFT — "Search for Products" /
"Enter Products" tabs · search input ("…by product name, ASIN, or SKU", 280ms debounce) ·
"Viewing X–Y of Z" + **Add All** · flat rows: 44px thumbnail (object-fit cover, 6px
radius, badge overlay) + 2-line-clamped 12.5px title + code chip with copy + family
chevron expanding lazy-loaded children (34px thumbs, indented) + per-row Add/Added ·
4 skeleton rows while loading · pager. RIGHT — "{n} Products Added" + **Remove All** ·
sortable Product column · per-row ✕ · "No data" empty state.

### eBay adaptation (all in eBay files — the `.h10-spw-ps-*` CSS is already shared)
- **Rows are LISTINGS** (ads are per-listing): thumbnail · 2-line title · item-ID code
  chip (+ copy) · SKU chip when matched · meta line in the Amazon register — price, qty,
  break-even (or "add cost" action chip), trailing-30d sales — each with a styled tip
  instead of today's cryptic "BE add cost · 30d €0.00".
- **Tabs**: "Search listings" (title/item ID/SKU) · "Enter item IDs" (textarea, parsed on
  newline/comma — the Amazon Enter-Products idiom).
- **Family grouping**: group rows by matched product (productIds[0]) with the family
  chevron expanding that product's other live listings — same lazy-expand interaction,
  powered by data already in `/builder/listings`.
- **States preserved**: "in campaign" conflict pill (skip/move resolution flow is ER2
  behaviour, unchanged), OOS flags for PRI, Add All, staged tray with per-row ✕ +
  Remove All + trailing-30d total (kept from today's tray, restyled).

### Images — source of truth (verified)
- `EbayListingIndex` has NO image field today. The discovery sync already calls Trading
  **GetMyeBaySelling** (ActiveList) + **GetItem** per new listing — both responses carry
  picture data (`PictureDetails.GalleryURL` / `PictureURL[]`) that the parser currently
  drops. **Zero additional API calls needed.**
- Migration (reversible, rollback stated): `EbayListingIndex.imageUrl TEXT NULL`.
- Sync: parse GalleryURL in the ActiveList sweep; GetItem `PictureURL[0]` as fallback
  during detail fetch. Backfill: existing rows fill on the next sweep organically; the
  sweep runs every 4h — plus a one-shot manual sweep at ship time.
- Serving: `/builder/listings` and `/products` rows gain `imageUrl` with server-side
  fallback to the matched product's primary catalog image (that IS the product's real
  image; provenance noted in the field name or tip). No image ⇒ the shared `.ph`
  placeholder — never a fake.
- Reuse: the same field feeds the **Products page** rows and **PromoteModal** (EV2 scope).

## 2 · Advanced-settings gap map (EV3)

Axis 1 — what the eBay API supports and the write layer ALREADY implements;
Axis 2 — what the wizard exposes today; the Δ column is the EV3 work.

| Capability (API/write layer) | In wizard today | Δ EV3 |
|---|---|---|
| Marketplace, name (+ grammar suggest) | ✅ Setup | polish only |
| **Scheduled start date** (`createCampaign.startDate`) | ❌ hardcoded "now (on launch)" | expose (Advanced, date ≥ today) |
| End date | ✅ Setup | styled date field |
| Key-based per-listing rates + campaign fallback | ✅ Rates | suggested-value chips idiom |
| **DYNAMIC rate strategy on key-based CPS** (`updateAdRateStrategy` supports any CPS; wizard offers DYNAMIC only on rules-based) | ❌ | expose (Advanced: FIXED per-listing ↔ DYNAMIC + cap) |
| Rules-based criterion (brands/categories/price, autoSelectFutureInventory) + live preview | ✅ Targeting | control polish (labels, tips) |
| Rate Discovery arming | ✅ Rates (GEN) | keep |
| Daily budget + suggested budget | ✅ Budget | "Suggested · Use" chip idiom |
| Smart Priority maxCpc | ✅ Budget | keep |
| Ad groups (name, default bid) + per-group keywords/negatives (EXACT/PHRASE/BROAD; neg EXACT/PHRASE) | ✅ Keywords&Bids | table polish |
| **Keyword bid suggestions** (`keyword-bid-suggestions` endpoint exists; wired only on the detail page; AU/DE/GB/US only) | ❌ in wizard | per-seed "Suggested · Use" where the market supports it; honest "n/a for IT/FR/ES" note elsewhere |
| Listing attach (E4: manual→first ad group, smart→campaign) | ✅ | destination selector when >1 ad group (small, honest upgrade over "first group") |
| Rule-pack binding at launch | ✅ Review | keep |
| Portfolios / placement multipliers / video boost / audience modifiers / campaign-level bid strategies | — no eBay API equivalent | **not built** — stated in the audit, never faked; our posture/rules system is the eBay-native answer and Review already links it |

## 3 · Verification standard for every EV phase

Native-resolution before/after screenshots diffed against the Amazon reference; spacing/
alignment/borders measured numerically; colours sampled from the PNG; prod click-through;
Amazon identical-after proof on any shared-file touch. No phase presents work the Owner
could visually fault first.
