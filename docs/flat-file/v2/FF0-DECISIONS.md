# FF0-DECISIONS — Decision register (present at the FF0 gate)

> Phase FF0 (read-only). Each decision has a recommendation + trade-offs. **FFD1–FFD8** are the spec's original register (Part VI). **FFD9–FFD14** were surfaced by the audits and need Owner input — FFD9 and FFD10 are the two that materially change the build. "Safe default" = I'll proceed on the recommendation unless you say otherwise; "**Needs decision**" = I will not lock it without your call.

---

## Original register (Part VI)

### FFD1 — Workbook structure
Per-channel sheets with `field@MARKET` column groups **vs** one sheet per channel-market **vs** single mega-sheet.
**Recommendation:** per-channel sheets + `field@MARKET` groups (as in the sample). Side-by-side market comparison, matches how you work, and keeps sheet count bounded (Amazon/eBay/Shopify, not 15 channel×market sheets).
**Trade-off:** wide sheets (5 markets × ~6 cols ≈ 30 market columns). Mitigated by colour-banded, collapsible market groups + frozen keys. **Safe default.**

### FFD2 — Clear semantics
`__CLEAR__` sentinel **vs** a paired `field:clear` column.
**Recommendation:** `__CLEAR__` sentinel (in the sample). Compact, no column doubling, README-documented.
**Trade-off:** a literal product value of "\_\_CLEAR\_\_" is impossible — acceptable (no real content is that token; escape hatch documented). **Safe default.**

### FFD3 — Formats
XLSX primary; per-sheet CSV as secondary output?
**Recommendation:** XLSX primary (multi-sheet + forced-text + validation are the whole point); CSV secondary, read-only, per-sheet convenience.
**Trade-off:** CSV can't carry forced-text/validation/multi-sheet — so CSV is export-only convenience, never the round-trip format. **Safe default.**

### FFD4 — Formula cells on import
Warn-and-use-computed-value **vs** hard-reject.
**Recommendation:** warn-and-use (read the computed value, raise a per-cell warning); hard-reject only in an opt-in strict mode.
**Trade-off:** a stray formula silently contributes its evaluated value — surfaced as a warning in the dry-run, so visible not silent. **Safe default.**

### FFD5 — Conflict default
File-wins (doctrine) **vs** always-ask.
**Recommendation:** file-wins by default, but **every** conflict displayed in the dry-run with both values + timestamps, and a per-field override to pick DB-wins.
**Trade-off:** file-wins can clobber a concurrent DB change — mitigated by always showing it and the snapshot fingerprint check (F2/§4). **Safe default.**

### FFD6 — Readonly/synced columns in the export
Include-greyed **vs** exclude.
**Recommendation:** include, greyed + `🔒`, ignored on import (in the sample). One file shows everything (buybox, fees, live status).
**Trade-off:** wider file. Worth it for a true source-of-truth view. **Safe default.**

### FFD7 — Per-market localized content columns
`title@IT`, `description@DE` in v1 **vs** shared-content-only.
**Recommendation:** include where the channel genuinely supports per-market content (the sample shows `title@IT`/`title@DE`). The census + live Amazon manifest decide the exact localized set per channel.
**Trade-off:** more columns; some markets may share content (then the cells simply repeat). **Safe default**, exact set finalized in FF1.

### FFD8 — Row-level fingerprints
Hidden `_meta` sheet only **vs** also a hidden per-row hash column.
**Recommendation:** `_meta`-only (in the sample). Keeps data sheets clean; row-matching is by SKU + channel + marketplace which is stable.
**Trade-off:** if a row's keys are edited, `_meta` matching needs a fallback — revisit with a per-row hidden hash column if FF3 fuzzing shows fragility. **Safe default.**

---

## New decisions surfaced by the FF0 audit

### FFD9 — Data-model foundation  🔴 **Needs decision** (see FF0-FINDINGS F1)
The spec named `MasterProduct → ProductVariation → VariantChannelListing`, but that chain is **deprecated**. The live chain is **`Product` (parent + child rows) + `ChannelListing`**.
**Recommendation:** build the round-trippable workbook on **`Product` + `ChannelListing`**. Treat `ProductVariation`/`VariantChannelListing` as **excluded** (or a readonly `Legacy` reference block only).
**Sub-question:** do any **live eBay** variations still depend on `VariantChannelListing` such that they must round-trip? The write-op census says only 4 eBay-path writes touch it — but confirm before we exclude it.
**Impact if wrong:** a workbook on the dead chain exports empty/stale and imports to models nothing reads. This is the one decision that gates FF1's data layer. **Please confirm: build on Product + ChannelListing, legacy chain excluded (readonly)?**

### FFD10 — How the per-market resolver is represented in the file  🔴 **Needs decision** (see FF0-FINDINGS F2)
Effective per-market values come from a resolver (`ChannelListingOverride → FieldLink → *Override + followMaster* → overrideData → master → default`). A naïve `price@IT` cell round-trips as a **silent no-op** when `followMasterPrice=true`.
**Option A (recommended):** export the **effective value** (`price@IT`) **+ a control column** (`price_follows_master@IT`). Editing the value auto-writes the override and flips the follow-flag on import; both shown in the dry-run. *(This is what the sample demonstrates.)* Readable, but adds one control column per governed field.
**Option B:** expose the **raw override columns** only (`price_override@IT` + `price_follows_master@IT`), never the effective value. More literal, less readable (blank override when following master is confusing).
**Option C:** effective value only, and make ANY edit create an override (drop the follow concept in the file). Simplest sheet, but can't re-attach a market to master from the file.
**Trade-off:** A balances readability + fidelity; B is most faithful to the DB; C loses the un-override capability. **Please pick A, B, or C** (I recommend A).

### FFD11 — Images  🟡 Safe default
Separate `Images` sheet (keyed `sku` + `slot` + optional `@MARKET`/channel) **vs** URL columns on `Products` **vs** exclude.
**Recommendation:** separate `Images` sheet — image relations are 1:N with `sortOrder`/`isPrimary`/hash invariants (census §6) that don't fit one product row.
**Trade-off:** a second keyed sheet to learn; but it keeps the field grid clean and lets images round-trip by URL. **Safe default** (sample ships without image rows to keep the demo focused; FF1 adds the sheet).

### FFD12 — JSON flattening set  🟡 Safe default
Which nested keys of `categoryAttributes` / `localizedContent` / `platformAttributes` become columns vs stay opaque.
**Recommendation:** flatten the **manifest-enumerated** set (the live Amazon template already declares expandable fields; eBay category aspects likewise); leave free-form JSON opaque/excluded. Finalize in FF1 against the live manifest.
**Trade-off:** fields not in the manifest won't get cells — acceptable, they're not operator-authored today. **Safe default.**

### FFD13 — Import apply routing (Amazon feed vs eBay direct-write)  🟡 Recommendation, worth confirming
Amazon "save" is an async **SP-API feed** (Amazon owns the record); eBay/Shopify "save" is a **direct DB write**. One import can touch all three.
**Recommendation:** the apply step routes per channel — Amazon changes → submit a `JSON_LISTINGS_FEED` (reuse the existing feed path) and reconcile via the report; eBay/Shopify changes → transactional DB write. The dry-run shows both; the `ImportJob` tracks feed job ids alongside direct-write results.
**Trade-off:** Amazon results are eventually-consistent (feed processing lag) — the processing report closes the loop. Confirm this is acceptable vs. an Amazon-writes-are-preview-only stance. **Recommendation; flag for FF2.**

### FFD14 — Large-artifact storage  🟡 Dependency (see FF0-FINDINGS F8)
Multi-market workbooks routinely exceed the current 1 MB base64-in-Postgres ceiling, above which exports are silently undownloadable today.
**Recommendation:** wire real object storage for `ExportJob.artifactUrl` before FF1 ships full-catalog workbooks — reuse the existing Cloudinary/asset pipeline if available, else add S3; or stream the artifact directly from the download route.
**Trade-off:** small infra task, but a hard prerequisite. **Please confirm the storage target** (reuse existing asset storage vs. new bucket vs. stream-only).

---

## Decision summary

| ID | Topic | Recommendation | Status |
|---|---|---|---|
| FFD1 | Sheet structure | Per-channel + `field@MARKET` | Safe default |
| FFD2 | Clear semantics | `__CLEAR__` sentinel | Safe default |
| FFD3 | Formats | XLSX primary, CSV secondary | Safe default |
| FFD4 | Formula cells | Warn-and-use | Safe default |
| FFD5 | Conflict default | File-wins, always shown | Safe default |
| FFD6 | Readonly columns | Include greyed | Safe default |
| FFD7 | Localized content | Include per-channel support | Safe default |
| FFD8 | Fingerprints | `_meta` only | Safe default |
| **FFD9** | **Data-model foundation** | **Product + ChannelListing; exclude legacy** | 🔴 **Needs decision** |
| **FFD10** | **Resolver representation** | **Effective value + follow-flag (Option A)** | 🔴 **Needs decision** |
| FFD11 | Images | Separate `Images` sheet | Safe default |
| FFD12 | JSON flattening | Manifest-enumerated set | Safe default |
| FFD13 | Apply routing | Amazon feed / eBay direct | Recommendation |
| FFD14 | Artifact storage | Real object storage before FF1 | 🟡 Dependency — confirm target |
