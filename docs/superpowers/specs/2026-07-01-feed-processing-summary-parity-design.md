# Feed Processing Summary — Amazon-Parity — Design Spec

**Date:** 2026-07-01
**Status:** DRAFT — for operator review before implementation
**Scope (approved):** Full parity P1–P5; Amazon-first, structured for eBay/Shopify reuse. (P6 manual-.xlsm import deferred.)
**Surface:** Amazon flat-file editor feed reports (`FeedSubmissionsPanel` + parser + storage). The editor dir is operator-flagged **untouchable** — this is an approved exception; changes stay surgical.

## Goal
Make Nexus's post-publish processing summary **as detailed as Amazon's**: report **every** error individually with its **error code, category, severity, full actionable message, affected attribute(s), and precise location**, plus a **by-error-code roll-up** — and let the operator **jump straight to the offending cell** in the editor. Export in a rich CSV and an **Amazon-layout Excel**.

## Current state (the gap — verified)
The SP-API `JSON_LISTINGS_FEED` report gives each issue: `sku, code, severity, message, attributeNames[], categories[], details`. Our parser (`amazon-flat-file-feed.service.ts`) keeps only `sku/code/severity/message`, **collapses all of a SKU's issues into one string**, and **regex-guesses the field** from the message (fragile; fails on the GALE `20017` image error — Italian media message has no `attribute – X` pattern → no field → no cell highlight). We also **discard the raw report** and store only `resultSummary` + a flat `perSkuResults[]`. The UI shows SKU · status · code · message only; no attribute, category, location, by-code view, or jump-to-cell.

## Design

### Channel-agnostic core (reuse requirement)
Define a **channel-neutral** parsed shape so eBay/Shopify can produce the same downstream UI/export later:
```ts
type FeedIssueSeverity = 'error' | 'warning' | 'info'
interface FeedIssue {
  code: string                 // Amazon issue code (e.g. "20017")
  severity: FeedIssueSeverity
  category?: string            // Amazon categories[0] (e.g. "INVALID_IMAGE")
  message: string              // FULL, untruncated
  attributeNames: string[]     // Amazon attributeNames (reliable location source)
  details?: string             // Amazon details
}
interface PerSkuResult {       // superset of today's shape (backward-compatible)
  sku: string
  status: 'success' | 'warning' | 'error'
  issues: FeedIssue[]          // NEW — every issue preserved
  // legacy fields kept for back-compat with already-stored rows:
  code?: string; message?: string; fields?: string[]
}
interface ParsedFeedReport { channel: 'AMAZON'|'EBAY'|'SHOPIFY'; summary: FeedReportSummary; perSku: PerSkuResult[]; feedError?: string; pending?: boolean }
```
`FeedIssue`/`ParsedFeedReport` live in a channel-neutral module; the Amazon parser is one producer. eBay/Shopify adapters (later) map their report → the same shape → same UI/export unchanged.

### P1 — Capture everything (backend parser)
- Rewrite the `JSON_LISTINGS_FEED` issue loop to emit `FeedIssue[]` per SKU: read `attributeNames`, `categories`, `details` directly; keep the **full** message; **do not concatenate** — one `FeedIssue` per report issue.
- Derive `status` per SKU from the max severity of its issues (unchanged rule).
- Keep the legacy `code/message/fields` fields populated (from the first/most-severe issue) so old UI paths + stored rows still work.
- **Persist the raw report** (gzip-decompressed JSON string) on the job for audit + re-parse.

### P2 — Location resolver (attribute → cell)
- A resolver maps an `attributeName` → the editor **column** for that (market, productType): `main_product_image_locator → { columnId, label: "Main product image" }`. Handles expanded/numbered fields (`bullet_point` → `bullet_point_1..5`, `purchasable_offer__our_price`, etc.) using the existing manifest/`expandSchemaField` logic.
- Per error, the location = `{ sku, attributeNames[], columns: [{id,label}], rowRef }`. This is our equivalent of Amazon's `A6` — but resolved to a named column + the SKU's row, and clickable.
- Unmapped attributes degrade gracefully (show the raw attribute name).

### P3 — UI parity (`FeedSubmissionsPanel`)
Two views per submission, mirroring Amazon's two sections:
1. **By error code (roll-up):** `code · category · severity · count · sample message` (e.g. "20017 · INVALID_IMAGE · ERROR · 18 · media blocked…"). Expand → the SKUs under that code.
2. **Per-error list:** one row **per issue** (not per SKU): `# · code · severity · category · affected column(s) · SKU · full message`. Full untruncated message (expand/collapse). Filter by status **and** code **and** attribute/category; search unchanged.
Summary block stays (processed / ok / warn / error). Backward-compat: if a stored job has no `issues[]`, fall back to today's per-SKU rendering.

### P4 — Jump-to-cell
- Each per-error row + each highlighted grid cell gets a **"Go to cell"** affordance. Clicking: closes the panel, scrolls the editor to that SKU's row, selects/flashes the resolved column cell (reuse the existing `_errorFields` → cell-decoration layer at `AmazonFlatFileClient.tsx:1399`, now fed by reliable `attributeNames` instead of the regex).
- The feed-result→row merge (`AmazonFlatFileClient.tsx:3345`) switches to consume `issues[].attributeNames` (resolved to columnIds) for `_errorFields`, so highlighting is correct for image/media errors too.

### P5 — Export parity
- **Rich CSV:** columns `sku, code, severity, category, affected_columns, message, details`.
- **Amazon-layout Excel (.xlsx):** three sheets/sections matching the sample — **Summary** (processed/errors/warnings), **By error code** (`# · code · category · message · affected column · count`), **By SKU** (`# · code · category · message · affected cell (column+SKU) · SKU`). Built server-side with `exceljs` (already a dep).

## Data model
`AmazonFlatFileFeedJob` (additive, nullable — no destructive migration):
- `rawReport Json?` — the decompressed report (audit/re-parse).
- `perSkuResults` — existing `Json?` column; now stores the superset shape (`issues[]` added). No schema change needed for the shape (it's `Json`), but a migration adds `rawReport`.
- Existing rows remain valid (UI falls back when `issues[]` absent).

## Non-goals
- P6 manual `.xlsm` import (deferred; separate follow-up).
- Actually wiring eBay/Shopify adapters (only the shape is made reusable now).
- Changing feed submission/polling mechanics (only parsing + display + export).

## Risks / constraints
- **Untouchable editor:** `FeedSubmissionsPanel` + `AmazonFlatFileClient` changes are the approved exception; keep them surgical + verify the grid/submit/export unaffected.
- **Backward compatibility:** already-stored `AmazonFlatFileFeedJob.perSkuResults` lack `issues[]` — UI + export must handle both shapes.
- **Attribute→column coverage:** some Amazon attributeNames may not map 1:1 to a grid column (nested/compound); resolver must degrade gracefully, never crash.
- **i18n:** Amazon messages are localized (Italian here); we store + show them verbatim (operator UI stays English chrome, message content passes through).
- **Report size:** raw reports can be large; store decompressed JSON but cap/skip persistence above a sane size (e.g. >1MB) to protect the row.

## Rough task breakdown (for the plan)
1. Channel-neutral `feed-report-types.ts` + `FeedIssue`/`ParsedFeedReport` (+ tests).
2. Parser rewrite to emit `issues[]` from `attributeNames/categories/details`, keep legacy fields, backward-compat (+ tests with a real `20017` report fixture).
3. `rawReport` column migration + persist raw report.
4. Attribute→column resolver (pure, tested) using the manifest.
5. `FeedSubmissionsPanel`: by-code roll-up + per-error list + full messages + filters (untouchable-surgical).
6. Jump-to-cell: feed-result merge uses resolved columns; "Go to cell" nav.
7. Rich CSV + Amazon-layout Excel export.
8. Regression pass: old jobs render, submit/grid unaffected, i18n/a11y.
