# FF0-WORKBOOK-SPEC — The source-of-truth workbook (finalized layout)

> Phase FF0 (read-only). Finalizes Part IV against the real data model (`Product` + `ChannelListing`, per F1), the multi-layer resolver (F2), dynamic market discovery, and Excel-proofing. **Gate artifact:** `FF0-SAMPLE-WORKBOOK.xlsx` in this folder — a real, openable workbook demonstrating this structure. Recommendations here map to the decisions in `FF0-DECISIONS.md`; the Owner approves the layout by opening the sample.

---

## 1. Sheets (order is deterministic)

| # | Sheet | Visibility | Contents |
|---|---|---|---|
| 1 | `README` | visible | Generated legend: every column's meaning, Action values, blank-vs-`__CLEAR__` rules, readonly markers, market list, version notes. A human learns the file from the file. |
| 2 | `Products` | visible | **Master/shared data** from `Product` (parent + child rows): identity, hierarchy, variant axes, brand, EAN/GTIN, shared content, physical/compliance, master pricing/cost. One row per SKU. |
| 3 | `Amazon` | visible | Per-market Amazon listing data from `ChannelListing where channel='AMAZON'`. Channel-shared columns first, then **`field@MARKET`** groups for every discovered Amazon market. |
| 4 | `eBay` | visible | Same shape for `channel='EBAY'`. |
| 5 | `Shopify` | visible (if present) | Same shape for `channel='SHOPIFY'` (`marketplace='GLOBAL'`). Emitted only if Shopify listings exist. |
| 6 | `Images` | visible | Image URL list keyed by `sku` + `slot` (MAIN/PT01…) + optional `@MARKET`/channel. Keeps 1:N image relations out of the field grid (census §6). |
| 7 | `_meta` | **veryHidden** | `snapshotId`, `schemaVersion`, `exportedAt` (ISO), resolved market list per channel, and per-row fingerprints. No data-area volatility lives on the visible sheets. |

**Markets are discovered, not hardcoded** (see FF0-MARKET-DISCOVERY §4.1): the `@MARKET` groups on each channel sheet = *(markets with live listings)* ∪ *(active `Marketplace` rows)*, so a newly activated market auto-appears next export.

---

## 2. Column conventions

### 2.1 The `Action` column (first data column on every editable sheet)

| value | meaning |
|---|---|
| *(blank)* | update-if-changed (default) |
| `ADD` | create this row (new product / new listing) |
| `DELETE` | delete — requires typed confirmation "DELETE N PRODUCTS" on apply (FF2); dry-run shows the full cascade (F13) |
| `IGNORE` | skip this row entirely |

Precedent: eBay File Exchange Action + Amazon `update_delete` — familiar, zero learning curve. **A missing row NEVER means delete** (Contract §4); deletion is only ever via `Action=DELETE`.

### 2.2 `field@MARKET` naming

Per-market columns use `field@MARKET` where MARKET is the `Marketplace.code` (`price@IT`, `quantity@DE`, `title@FR`, `status@IT`). Channel-shared columns (no market suffix) come first, then market groups, each group colour-banded and collapsible (matching the flat-file editor's per-market colour palette). Market order within a channel: **primary (IT) first, then alphabetical** — deterministic (Contract §1).

### 2.3 Blank vs clear (Contract §4)

- **Blank cell** = "no change" — the diff engine ignores it (closes F7's blank-overwrite class).
- **`__CLEAR__`** sentinel = "set this field empty." Symmetric on export/import, documented in README.

### 2.4 Readonly columns (Contract §7)

READONLY-SYNCED + DERIVED fields (census §1) render **greyed, header-prefixed `🔒`**, and are **ignored on import** with an informational note. They're present so one file shows everything (buybox, fees, live status, sync state).

### 2.5 The resolver control columns (F2 — the critical mechanism)

For every per-market field governed by the follow-master resolver, the sheet carries **both** the value and its control:

| column | role |
|---|---|
| `price@IT` | the **effective** price (what the resolver returns — readable) |
| `price_follows_master@IT` | `true`/`false` — is this market following the master value? |

**Import rule:** editing `price@IT` while `price_follows_master@IT=true` will, on apply, write `priceOverride` **and** flip `followMasterPrice=false` atomically — so the edit actually takes effect (never the silent no-op of F2). Setting `price_follows_master@IT=true` re-attaches to master and clears the override. Both transitions are shown in the dry-run. (Applies to title/description/price/quantity/bullets — census §3.2.)

### 2.6 Forced-text & format rules (Contract §5)

| column class | Excel treatment |
|---|---|
| `sku`, `parent_sku`, `master_sku`, `asin`, `ean`, `upc`, `gtin`, `fnsku`, `ebay_item_id`, `listing_id@MKT`, browse-node ids | **forced text** (`numFmt='@'`, value written as string) — no scientific notation, no leading-zero loss |
| dates (`first_inventory_date`, sync timestamps) | **ISO 8601 string** (`2026-07-05`) |
| decimals (`price@MKT`, `base_price`, weights) | number cells; **locale-safe** — the reader normalizes IT comma vs dot on import; README states the export uses `.` |
| enums (`status`, `fulfillment_method`, `pricing_rule@MKT`, follow flags) | data-validation dropdown; `strict` vs `open` per the registry |
| arrays (`bullet_points`, `keywords`) | single cell, ` \| `-joined (escaped); README documents the delimiter |

---

## 3. Excel ergonomics

- **Frozen panes:** header row + key columns (`Action`, `sku`) frozen (`views:[{state:'frozen', xSplit:2, ySplit:1}]`).
- **Data-validation dropdowns** for enum columns, honoring `enumMode` (`strict` = list-only; `open` = suggestions).
- **Header comments** from each column's `description`/`guidance` (REQUIRED/RECOMMENDED/OPTIONAL), linking back to README.
- **Column widths** from the registry.
- **Readonly columns** visibly grey; **header row + readonly columns protected** (sheet protection with locked cells) so accidental edits are visible/blocked.
- **Required columns** flagged in the header (e.g. `*` suffix + amber header).
- **Formula cells on import:** warn-and-use-computed-value (FFD4), flagged per cell.

---

## 4. Determinism & fingerprints (Contract §1, §6)

- **Row order:** parent SKU asc, then child SKU asc (parents immediately above their children); standalones interleave by SKU. Final tiebreak: SKU. Deterministic.
- **Column order:** registry order for shared columns; discovered-market order (IT-first, then alphabetical) for `@MARKET` groups.
- **No volatile values on visible sheets.** `snapshotId`, `exportedAt`, run ids live only on `_meta`.
- **Fingerprints:** hidden `_meta` sheet holds `snapshotId` + a per-row hash (SKU + channel + serialized effective field set) captured at export. On import, a cell changed in the file **and** in the DB since `snapshotId` ⇒ **conflict**, surfaced in the dry-run with both values; default resolution **file-wins**, always shown (Contract §6, FFD5). (FFD8: `_meta`-only vs also a per-row hidden hash column — recommend `_meta`-only, revisit if row-matching proves fragile.)
- **Byte-identity gate (FF1):** export twice with identical DB + options ⇒ byte-identical file (excluding `_meta` timestamps).

---

## 5. Templates & subsets

- **Blank template:** same structure, zero data rows (headers + validation + README + `_meta` schema only).
- **Subset/filtered export:** any grid selection exports as a first-class workbook; subset imports affect **only included rows** — never delete-by-absence (Contract §4).
- **Per-sheet CSV** is a secondary read-only convenience output (FFD3); XLSX is primary (multi-sheet + formatting protections are the point).

---

## 6. The sample workbook (gate artifact)

`FF0-SAMPLE-WORKBOOK.xlsx` (generated by `FF0-sample-generator.mjs` in this folder) demonstrates the structure with **three representative products**:

1. **Parent-with-variants** — `GALE-JACKET` parent + two children (`GALE-JACKET-BLK-M`, `GALE-JACKET-BLK-L`), Amazon, showing hierarchy + variant axes + per-market price/qty/status across IT/DE/FR/ES/UK.
2. **Standalone** — `XAVIA-GLOVE-01`, Amazon-only, showing a simple single-row product.
3. **Multi-channel** — `AIREON-STD`, listed on **both** Amazon and eBay, showing the same SKU on two channel sheets with independent per-market columns.

It demonstrates: all sheets in order; the `Action` column; `field@MARKET` groups; **forced-text identifiers** (an EAN with a leading zero — `08054323310123` — and ASINs stay text, not `8.05E+12`); **ISO dates**; **locale-safe decimals**; **greyed readonly** columns (`🔒 status@IT`, `🔒 buybox_price`); the **resolver control columns** (`price@IT` + `price_follows_master@IT`); frozen header + key columns; enum dropdowns; and the hidden `_meta` sheet with `snapshotId` + per-row fingerprints.

> **Data honesty:** the sample's row values are **clearly-labelled ILLUSTRATIVE data** (stated on the README and `_meta` sheets), not a live catalog export — FF0 is read-only and has no DB access. The **structure, formatting, and Excel-proofing are real and production-shaped**; FF1's first task is to generate the same workbook from live data and byte-diff it.

---

## 7. Open items resolved at the gate (see FF0-DECISIONS)

FFD1 (per-channel sheets + `field@MARKET`) · FFD2 (`__CLEAR__`) · FFD7 (per-market localized content set) · **FFD9 (legacy chain include/exclude)** · **FFD10 (resolver control-column model)** · FFD8 (fingerprint placement). The census's residual JSON-flattening set (§8) is finalized in FF1 against the live Amazon manifest.
