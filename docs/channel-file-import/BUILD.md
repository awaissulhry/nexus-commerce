# CFI build — the lane contract (R-CFI-1, 2026-09-24)

Worktree: **`/private/tmp/cfi-build`**, branch **`cfi/build`** (from `pes/phase-0` 4984103d1). Every lane edits ONLY there, with
worktree-prefixed absolute paths (`/private/tmp/cfi-build/apps/...`) — never `/Users/awais/nexus-commerce/apps/...` (that is the
shared tree other sessions push from). Main session integrates, runs the corpus proof, commits, and merges into `pes/phase-0`.

Private DB for every real-database run: `nexus_cfi_20260924` (local Docker, `127.0.0.1:55439`). Never `nexus_development`, never prod.
API tests: run from `/private/tmp/cfi-build/apps/api` with `DATABASE_URL` pointing at the copy only when a test needs a real DB;
PGlite `formulaDatabase()` is the default for DB-arm tests (see existing `*.vitest.test.ts`).

## 1. Shared contract (main session owns `packages/shared/catalog-transfer.ts`; lanes read, never edit)

`TransferRow` gains optional fields (all additive, absent = today's behaviour):

| field | meaning |
|---|---|
| `origin?: 'channel-file'` | The value was read from the channel's OWN file (Amazon template / our eBay workbook). The planner then (a) allows a field that is read-only on a live listing (it describes what the channel holds), (b) allows `list_price` (RRP, a saved listing fact — `studio-publication-amazon.ts:134-135`), (c) accepts the identity/presence/price fields below. |
| `clearIfPresent?: true` | Only with `action: 'CLEAR'`. Q1 full-update blank: clear the market value ONLY if Nexus's effective market value is non-empty; otherwise the row plans nothing (no cell, counted `alreadyEmpty`). |
| `fileSku?: string` | The SKU as written in the file when the row was resolved to a different Nexus SKU (identity step). Display + audit only. |

New row shapes (entity / field / value) — only with `origin: 'channel-file'`:

| entity | field | value | planner + apply |
|---|---|---|---|
| `Listings` | `sellerSku` | string | Stored in `platformAttributes.sellerSku` — the identity the studio publisher already reads (`studio-publication-amazon.ts:50`). Emitted only when the channel's SKU ≠ the Nexus SKU. |
| `Listings` | `presence` | `'ENDED'` | Q1 delete: the channel deleted this listing on this market. Apply marks the listing ended in Nexus with **no outbound push** (writer named in §4). Product untouched. |
| `Overrides` | `price` | number (gross, market currency) | Q2: applied through `writeChannelPrices` in record-only mode (§4), `expectedVersion` from the reviewed listing version. |
| `Overrides` | `sale` | `{ value: number \| null; start: string \| null; end: string \| null }` | Q2: the sale window through the same door, same mode. |

`ParsedInput` (host side) gains `links?: { fileSku: string; proposedSku: string; reason: string }[]` (persisted in the job payload
and returned by `transferJobStatus`, with a `deletes` summary; an UNCONFIRMED delete is an issue with `field: 'presence'`) — identity proposals the Owner must confirm (CFI-4).
A preview request may carry `links: Record<fileSku, nexusSku>` (confirmed); unconfirmed proposals stay issues that name the proposal.

**Delete confirmation is a LIST (review finding 4, 2026-09-25).** `confirmDeletes` = `true` (legacy: all) or a JSON array of SKUs;
readers confirm only delete rows whose FILE SKU is listed (re-review 2026-09-25: matching the resolved Nexus SKU let one tick confirm
an alias's delete too). The job's `deletes` summary carries `fileSku` + channel, marketplace, accountId; an ASIN-only match never
records a `sellerSku` (it is another offer on the same product). The web sends only the SKUs it showed and the Owner
ticked. A presence row carries `fileSku` and ends only the listing that holds that seller SKU (reader filters identity by account and
alias; planner re-checks).

**Zero-loss ledger (CFI-9).** Both readers return `ledger: { row, sku, header, outcome: 'row'|'excluded'|'refused'|'skipped-row', field?, reason? }[]`
— one entry per POPULATED cell, written at the branch that decides it — and export a pure checker (`checkLedger` / `checkEbayLedger`)
returning `{ unaccounted, duplicated, danglingRows }`. The corpus proof requires all three empty for every file.

## 2. Lanes and their files (disjoint)

| lane | steps | files (worktree) |
|---|---|---|
| **L1 door** | CFI-1 | NEW `apps/api/src/services/pim/channel-file-sniff.ts` (+test); `workbook-parse.worker.ts`; `workbook-parse-protocol.ts`; `catalog-editor-workbook.ts`; `routes/catalog-transfer.routes.ts`; `catalog-transfer-file.ts` (only: never ExcelJS on an Amazon template) |
| **L2 amazon** | CFI-2, CFI-3 reader, CFI-4 reader, CFI-6 reader | `services/amazon/template-workbook.ts`; `services/pim/catalog-amazon-workbook.ts` (+ their tests) |
| **L3 ebay** | CFI-5, CFI-6 reader | `services/pim/catalog-ebay-workbook.ts` (+ test) |
| **L4 plan** | CFI-3/4/6/7 planner + apply + door | `catalog-transfer-plan.ts`; `catalog-transfer.service.ts`; `catalog-transfer-jobs.ts`; `channel-price-write.service.ts`; `content-resolver.ts` only if the new-listing fix needs it (+ tests) |
| **L5 web** (wave 2) | CFI-7/8 UI, CFI-1 UI | web `products/catalog-transfer/*`, `products/[id]/edit/_studio/import/ProductTransferDrawer.tsx` + review components |

Interfaces between lanes:
- L1 ↔ L2: the worker returns `{ kind: 'amazon', parsed: AmazonTemplateParse, expandedBytes }` (plain data). L2 exports
  `resolveAmazonCatalogWorkbook(parsed, { accountId, marketplace, familyId?, mode, links?, productId? })` (host, Prisma) and keeps
  `readAmazonCatalogWorkbook(buffer, …)` as a thin wrapper for existing callers/tests. `productId` scopes to one product group (drawer).
- L1 ↔ L3: the worker returns `{ kind: 'ebay', table }` for ANY sheet whose header row carries `SKU`, `Parent/Child`, `Parent SKU`,
  `Category ID` (sheet name free). L3 exports `resolveEbayWorkbook(table, productId)` (drawer, unchanged name) and NEW
  `resolveEbayCatalogWorkbook(table, { links? })` (catalog page, any number of families).
- L2/L3 → L4: rows only through the contract above. L4 never parses files.

## 3. Rules every lane follows

- Generic only: driven by the file's keys, the template's own settings/dictionaries and the category schema. No family names, no SKU
  patterns, no market-specific code paths except data tables keyed by language.
- Zero silent loss: every populated cell ends as a row, an exclusion with a written reason, or an issue with a written reason.
- Never refuse a whole file for one column's problem; refuse the column (or the row) and say why.
- Import never publishes: no outbound queue row may be created by any import path (L4 asserts it in a test).
- Quantity is never imported (EU merchant quantity is one number; FBA never): exclusion with the file value in the message.
- Language: a market's text is stored in that market's language; a NEW product never gets a non-primary-language Shared name.
- Tests from `apps/api` only; fixtures are generated in the test (JSZip-built minimal templates) or trimmed copies — never the Owner's
  originals. Every new rule gets a test that fails when the rule is removed (the main session mutation-checks each one).
- Typecheck: `npx tsc --noEmit -p apps/api/tsconfig.json --incremental --tsBuildInfoFile /tmp/cfi-<lane>.tsbuildinfo` (fresh file).
- Do NOT edit `packages/shared/**`, `docs/**`, design-system files, or another lane's files. Ask the main session.

## 4. Named decisions (main session, 2026-09-25 ~00:20, from the code survey)

**Environment.** Worktree packages were installed (`npm ci`); `packages/shared` and `packages/events` were built (`npm run build`
in each). The main session already added the §1 fields to `packages/shared/catalog-transfer.ts` and rebuilt `dist`. Worktree
`apps/api/.env` = the local one with `DATABASE_URL`/`DIRECT_URL` → **`nexus_cfi_test`** (a fresh `pg_dump` copy; the test guard
accepts names containing "test") + `NEXUS_AMAZON_ENV_TOKEN=off`; there is NO root `.env` in the worktree (production keys absent).
Baseline 2026-09-25: `tsc` 0 errors; import-area vitest 19 files, 255 passed, 3 skipped.

**D1 presence ("the channel deleted this listing", nothing sent)** — no writer exists (survey: `presenceIntent`/`channelFact`/`ended*`
are raw-SQL columns, `migrations/20260913180000_pr_presence/migration.sql:27-42`, not in the Prisma model; only `listingStatus:'ENDED'`
has writers, and `removeAmazonListing` sends a delete). L4 adds ONE writer `recordChannelDeletion(tx, listingId, { userId, jobId })`:
Prisma `listingStatus:'ENDED', isPublished:false, offerActive:false, version+1`; raw SQL `presenceIntent='ENDED'`,
`presenceIntentAt/By/Reason`, `channelFact='ABSENT'`, `channelFactAt=now()`, `channelFactVia='channel-file-import'`,
`endedAt/By`, `endedReason='channel-file-delete'`; PENDING outbound rows of that listing are cancelled (named in the audit row).
Nothing is enqueued. 🔴 Safety: a delete row is applied only when the preview request carries `confirmDeletes: true`; without it the
row is an issue that states the channel evidence ("Amazon last reported this listing on <ChannelDrift.lastCheckedAt> / it has ASIN
<externalListingId>"). A file can be older than the channel (GALE DE NEW TEMPLATE is from May 2025).

**D2 record-only price door** — `writeChannelPrices({ …, recordOnly: 'channel-file-import' })` (a closed-set literal, like
`PriceWriteUnguardedReason`): the same column writes, CAS, `ChannelListingOverride` audit and `PriceChangeEvent` timeline (reason names
the file), but **no PRICE_UPDATE row, no cancel, no fire**. If a PENDING `PRICE_UPDATE` exists for the listing, the target is
`refused` with "A price change is waiting to be sent to <channel>. Send or cancel it before importing the channel's price." Guarded by
`expectedVersion` = the reviewed listing version (+1 if this same apply already patched that listing — our own bump, same transaction).
If the timeline source is a DB enum, add the value by an additive migration (pre-approved) + baseline.

**D3 full-update blank (`clearIfPresent`)** — the planner asks `resolveBatch` (`services/pim/mapping/resolve-batch.service.ts:153`,
batch per channel·market·account·alias·locale·productType with `fieldKeys`) for the effective value; empty ⇒ no cell (count it as
`alreadyEmpty` in the job counts); non-empty ⇒ a CLEAR cell, before = the effective value. Readers emit `clearIfPresent` rows only
for columns the file carries, whose cell is blank on a FULL row (explicit or the template's default), whose key maps to exactly one
schema field, and which are not managed / relationship / identifier / record-action keys. A list/measure field is blank only when
ALL its slots are blank.

**D4 identity links** — readers resolve a file SKU to a Nexus SKU in this order: exact SKU → the listing identity the studio already
reads (`Offer.sku`, `platformAttributes.sellerSku|seller_sku|sku|item_sku`, `flatFileSnapshot.item_sku` on the same channel·market)
→ ASIN / Item ID = a listing's `externalListingId` on that channel·market → (parents only) all of the file parent's resolved children
share ONE Nexus parent. Steps 2–3 resolve automatically (the row carries `fileSku`, and a `Listings sellerSku` row is emitted when the
channel SKU ≠ Nexus SKU). Step 4 is only a PROPOSAL: returned in `links`, and the rows are issues ("Link Amazon DE parent MOSS-JACKET to
IT-MOSS-JACKET?") until the preview request carries `links: { 'MOSS-JACKET': 'IT-MOSS-JACKET' }`. Unresolved SKUs: create only in
create/upsert mode with a family, Shared name only from a primary-language file; otherwise the name goes to its language only and a
new product without a primary-language name is an issue ("needs an Italian name").

**D5 drawer + Amazon** — the drawer resolves the Amazon account automatically when exactly one active Amazon connection covers the
file's marketplace; otherwise an issue "Choose the Amazon account" (L5 adds the picker). The drawer scopes rows to its product group
(`productId`): rows for SKUs outside the group are exclusions "Outside this product; use Catalog import".

**D6 apply what is valid (CFI-7)** — `applyTransferJob(id, userId, reviewToken, { readyOnly: true })` accepts an `INVALID` job;
records whose preview status is `INVALID` are skipped (status kept, counted `skipped` in the receipt); the rest applies as today.
Without `readyOnly` an INVALID job still refuses (today's contract). Route body gains `readyOnly`.

**D7 channel value in the review (CFI-8)** — the preview adds to each listing cell `channel?: { value, readAt, source } | { same: true, readAt }`
from `ChannelDrift` (`schema.prisma:19715`; entries `{field, ours, theirs, source, checkedAt}`, only differing fields stored;
`checkedBySource[src].outcome === 'compared'` without an entry ⇒ the channel equalled Nexus at `at`). Amazon keys: root attribute
(`material`) with path→value maps, content `item_name[de_DE]` (`services/channel-drift/amazon-content-compare.ts:46,77-80`).

**D8 the OUTERWEAR SP-API sheet** (2 GALE files: Title-Case attribute names, `Operation`, no market/language) — L1's sniff recognises
it as `amazon-attribute-sheet` and sends it to the existing "Map a source file" door with the reason; a generic suggested mapping is a
later step (CFI-5b). Counted as explained in CFI-9.
