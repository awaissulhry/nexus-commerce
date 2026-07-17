# Feed Processing Summary — Amazon-Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make Nexus's post-publish feed summary as detailed as Amazon's — every error individually, with code/category/severity/full-message/affected-attribute/location, a by-code roll-up, jump-to-cell, and rich CSV + Amazon-layout Excel export.

**Architecture:** A channel-neutral parsed shape (`FeedIssue`/`ParsedFeedReport`) produced by the Amazon parser; a pure attribute→column resolver enriches each issue at reconcile time; the richer results are stored in the EXISTING `AmazonFlatFileFeedJob.perSkuResults` Json column (NO migration). The `FeedSubmissionsPanel` gains by-code + per-error views + jump-to-cell; server + client add rich CSV and Amazon-layout `.xlsx` export.

**Tech Stack:** Fastify/Prisma/Vitest (apps/api), Next/React (apps/web), exceljs (already a dep).

## Global Constraints
- **No DB migration** in v1 — the superset `perSkuResults` shape (adds `issues[]`) fits the existing `Json?` column. Raw-report persistence is a deferred follow-up (would need a migration → separate approval).
- **Backward compatible:** already-stored feed jobs lack `issues[]`; parser keeps legacy `code/message/fields`, and UI/export fall back when `issues[]` is absent.
- **Untouchable editor:** `FeedSubmissionsPanel.tsx` + `AmazonFlatFileClient.tsx` are the approved exception; changes surgical + verified (submit/grid/export unaffected).
- **Channel-neutral core:** the parsed types carry `channel`; Amazon is the only producer now, but eBay/Shopify adapters can reuse the UI/export unchanged later.
- **Resolver degrades gracefully:** an unmapped `attributeName` shows its raw name, never crashes.
- **Messages pass through verbatim** (localized Italian preserved); operator chrome stays English.

---

### Task 1: Channel-neutral types + parser rewrite (P1) — apps/api, TDD

**Files:**
- Create: `apps/api/src/services/feed-report-types.ts`
- Modify: `apps/api/src/services/amazon-flat-file-feed.service.ts` (the `parseProcessingReport` + issue loop, ~87–195)
- Test: `apps/api/src/services/amazon-flat-file-feed.vitest.test.ts` (extend/create) + a real report fixture `apps/api/src/services/__fixtures__/feed-report-20017.json`

**Interfaces (Produces):**
```ts
// feed-report-types.ts
export type FeedIssueSeverity = 'error' | 'warning' | 'info'
export interface FeedIssueColumn { id: string; label: string }
export interface FeedIssue {
  code: string; severity: FeedIssueSeverity; category?: string
  message: string; attributeNames: string[]; details?: string
  columns?: FeedIssueColumn[]   // filled by the resolver (Task 2)
}
export interface PerSkuResult {
  sku: string; status: 'success' | 'warning' | 'error'
  issues: FeedIssue[]
  code?: string; message?: string; fields?: string[]   // legacy, kept populated
}
export interface FeedReportSummary { messagesProcessed: number; messagesSuccessful: number; messagesWithWarning: number; messagesWithError: number }
export interface ParsedFeedReport { channel: 'AMAZON'|'EBAY'|'SHOPIFY'; summary: FeedReportSummary; perSku: PerSkuResult[]; feedError?: string; pending?: boolean }
```

- [ ] **Step 1:** Build the fixture `feed-report-20017.json` — a real `JSON_LISTINGS_FEED` report: `{ header, issues:[ 18 × {sku, code:"20017", severity:"ERROR", message:"<full IT media text>", attributeNames:["main_product_image_locator"], categories:["INVALID_IMAGE"]} ], summary:{ messagesProcessed:21, messagesAccepted:3, messagesInvalid:18, errors:18, warnings:0 } }`. (Model on the operator's GALE example.)
- [ ] **Step 2:** Write failing tests: parsing the fixture yields `summary` (21/3/0/18), and `perSku` where each errored SKU has **one `FeedIssue`** carrying `code=20017`, `severity='error'`, `category='INVALID_IMAGE'`, full `message`, `attributeNames=['main_product_image_locator']`; the 3 accepted SKUs are `success` with `issues:[]`; legacy `code/message` still populated. Also a multi-issue-per-SKU case (2 issues, different attributes) stays as 2 `FeedIssue`s. Run → FAIL.
- [ ] **Step 3:** Implement: add `feed-report-types.ts`; rewrite the issue loop to emit `FeedIssue[]` (read `attributeNames`/`categories`/`details`; **don't concatenate**); derive per-SKU `status` from max severity; populate legacy `code/message/fields` from the most-severe issue (fields = attributeNames for now). Keep the `pending`/empty-report guards + feed-level-error path.
- [ ] **Step 4:** Run tests → PASS. `cd apps/api && npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(feed-report): structured per-issue parsing w/ attributeNames+category (P1)`.

---

### Task 2: Attribute→column resolver (P2) — apps/api, TDD

**Files:** Create `apps/api/src/services/amazon/feed-attribute-columns.ts` (+ test). Modify `amazon-flat-file-feed.service.ts` reconcile to enrich issues with `columns` (uses the job's marketplace+productType manifest).

**Interfaces (Consumes Task 1):**
```ts
/** Map an Amazon attributeName → editor columns. Uses the same expansion as the
 *  manifest (bullet_point → bullet_point_1..5, purchasable_offer__*, etc.). */
export function resolveIssueColumns(attributeNames: string[], manifestColumnIds: string[]): FeedIssueColumn[]
```

- [ ] **Step 1:** Failing tests: `main_product_image_locator` → `[{id:'main_product_image_locator', label:'Main product image'}]`; `bullet_point` → the 5 numbered columns present in the manifest; unknown attr → `[{id:attr, label:attr}]` (graceful); a compound like `purchasable_offer` → the expanded price columns. RED.
- [ ] **Step 2:** Implement the resolver (pure) using a label map + the manifest column-id list. GREEN. tsc clean.
- [ ] **Step 3:** Wire into `reconcileFeedJob`: after parse, load the (market, productType) manifest column ids, call `resolveIssueColumns` per issue, attach `columns`. Store the enriched `perSku` in `perSkuResults`. (Reuse `getFeedSchemaHints`/manifest — no new SP-API calls beyond what reconcile already has cached.)
- [ ] **Step 4:** Commit `feat(feed-report): resolve affected attributes → editor columns (P2)`.

**★ CHECKPOINT — pause for operator approval before the untouchable-editor + export tasks (P3–P5).**

---

### Task 3: Panel parity — by-code roll-up + per-error list (P3) — untouchable editor

**Files:** Modify `apps/web/src/app/products/amazon-flat-file/FeedSubmissionsPanel.tsx`.

- [ ] **Step 1:** Add a view toggle: **By error code** (aggregate rows: `code · category · severity · count · sample message`; expand → SKUs) and **By error** (one row per `FeedIssue`: `# · code · severity · category · affected column(s) · SKU · full message` with expand/collapse for long messages).
- [ ] **Step 2:** Build both views from `perSkuResults[].issues[]`. **Fallback:** when a job has no `issues[]` (legacy), render today's per-SKU table. Add filters: status + code + attribute/category; keep search.
- [ ] **Step 3:** tsc clean; reason-verify no data/submit path touched. Commit `feat(feed-report): by-code + per-error panel views w/ full detail (P3)`.

---

### Task 4: Jump-to-cell (P4) — untouchable editor

**Files:** Modify `FeedSubmissionsPanel.tsx` + `AmazonFlatFileClient.tsx` (feed-merge ~3345, cell-decoration ~1399).

- [ ] **Step 1:** Change the feed-result→row merge to set `_errorFields` from `issues[].columns[].id` (reliable) instead of the regex `fields`. Cell-decoration keeps working (now correct for image errors).
- [ ] **Step 2:** Add a "Go to cell" affordance on each per-error row → closes panel, scrolls editor to the SKU's row, selects/flashes the resolved column cell (reuse existing scroll/select). If multiple columns, first one.
- [ ] **Step 3:** tsc + `apps/web` build clean; verify grid/paste/submit unaffected. Commit `feat(feed-report): jump from error to the exact editor cell (P4)`.

---

### Task 5: Export parity (P5) — rich CSV + Amazon-layout Excel

**Files:** Modify `FeedSubmissionsPanel.tsx` (`exportCsv`); add a server endpoint `POST /api/amazon/flat-file/feeds/:feedId/export.xlsx` (routes + a small export builder using exceljs) OR client-side xlsx.

- [ ] **Step 1:** Rich CSV columns: `sku, code, severity, category, affected_columns, message, details` (one row per issue).
- [ ] **Step 2:** Amazon-layout `.xlsx`: 3 sheets — **Summary** (processed/errors/warnings), **By error code** (`# · code · category · message · affected column · count`), **By SKU** (`# · code · category · message · affected cell · SKU`), matching the operator's sample. Built from the stored `perSkuResults`.
- [ ] **Step 3:** tsc/build clean. Commit `feat(feed-report): rich CSV + Amazon-layout xlsx export (P5)`.

---

### Task 6: Regression + backward-compat + i18n/a11y

- [ ] **Step 1:** Verify: a legacy job (no `issues[]`) renders via fallback; a new job renders full detail; submit/grid/paste/export unaffected; localized messages pass through; keyboard/aria on the new views + Go-to-cell.
- [ ] **Step 2:** `apps/api` + `apps/web` builds clean. Commit `test(feed-report): backward-compat + regression hardening (P6)`.

## Self-review
- Coverage: P1→T1, P2→T2, P3→T3, P4→T4, P5→T5, regression→T6. ✅
- No migration (superset in existing Json); raw-report persistence deferred (noted).
- Backward-compat threaded through T1 (legacy fields), T3 (fallback), T6 (verified).
- Untouchable-editor tasks (T3–T5) gated behind the ★ checkpoint for operator approval.
