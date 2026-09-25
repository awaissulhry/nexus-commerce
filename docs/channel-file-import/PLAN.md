# Channel file import (CFI) — import the native Amazon templates and our eBay workbooks "as is"

Lane CFI · session prompt `SESSION-PROMPT-2026-09-24.md` · started 2026-09-24. **Status: §6 measured. ✅ R-CFI-1 (2026-09-24
~23:45): the Owner approved amendment CFI-A1 with Q1 (a) and Q2 (a) — *"Yes, I agree with you. Go ahead with your recommendation."*
Building in the §4 order.** Evidence for every number below: `records/2026-09-24-results.md` (+ the files it names).
Labels: **read** = seen in code or a file · **measured** = a run on the private DB copy · **inferred** = follows from code, not run.

## §0 What exists (20 lines)

1. Three import engines (read): **catalog-transfer** `apps/api/src/services/pim/catalog-*` — used by the product-sheet drawer (`routes/catalog-transfer.routes.ts:45,56`) and `/products/catalog-transfer` (`:125`); the July **FX flat-file wizard** (`routes/amazon-flat-file.routes.ts:1011` parse, `:1547` sync-rows); **FF2** (`services/flat-file/**`, its own workbook only, no web caller).
2. The legacy import-wizard only stages shared-product SET rows into a catalog-transfer job (`services/import-wizard.service.ts:21-30`); it never reads channel files.
3. Catalog-transfer contract: long rows, SET/CLEAR/INHERIT, empty = unchanged (`docs/2026-09-05-catalog-transfer.md:19,29`; `packages/shared/catalog-transfer.ts`).
4. A preview is a staged job in `BulkOperation` (24 h); apply re-checks each record; import never publishes (`services/pim/catalog-transfer-jobs.ts:64-121`, `docs/2026-09-05-catalog-transfer.md:39`).
5. `detectAmazonTemplate` (jszip + XML) reads the NEW grammar (keys `#N.`/`::`) and the OLD one (`item_sku` row) (`services/amazon/template-workbook.ts:329-339,444`); strict mode refuses formulas (`:488`).
6. Record actions come only from `::record_action`, by a hand list of words (`template-workbook.ts:285-304`); blank = replace.
7. Native Amazon import exists ONLY on the catalog page, File type "Amazon template" (web `products/catalog-transfer/page.tsx:82,89` → `catalog-transfer.routes.ts:135` → `catalog-amazon-workbook.ts:101`), and that parse runs on the request thread.
8. The Amazon adapter: new grammar only, one market + one language = the destination (`catalog-amazon-workbook.ts:21-23,46-49`); exact schema paths (`:57-60`); declared ASIN → `merchant_suggested_asin` (`:51-54`).
9. It keeps out: delete/unknown rows (`:33`), `::record_action` (`:43`), price/offer/quantity (`:45,74`), parentage + parent SKU (`:50`), other identifiers (`:56`), fields read-only on a live listing (`:73`).
10. It creates new products only in create/upsert mode with a family; the Shared `name` is the file's title in any language (`:114-131`).
11. The product-sheet drawer has no Amazon branch and accepts `.xlsx/.csv/.zip` only (`workbook-parse.worker.ts:51,63-83`; web `ProductTransferDrawer.tsx:203`).
12. The drawer's worker (heap cap, 90 s) protects only the drawer (`services/pim/workbook-parse.ts:22-24`; `docs/2026-09-16-studio-import-wedged-production.md`).
13. Our eBay workbook adapter: drawer only, one `ebay_(it|de|fr|es|uk)` sheet, one product group, existing listings matched by Item ID + parent + SKU (`catalog-ebay-workbook.ts:33-54,78-97,157-178`).
14. eBay values: 26 fixed columns, aspects by label, Image 1–6 as a list, weight + unit; price/qty/status kept out; a filled `Action` is refused (`:17-28,105-137`).
15. GALE eBay IT was imported in production on 09-15: 105 records, 0 differences, after its 4 legacy shells were adopted as aliases (`docs/2026-09-15-ebay-workbook-import.md:43-54`).
16. GALE Amazon IT `Modello` was imported into the studio on 09-14; price, FBA, DE/FR/ES and other families were left out (`docs/audits/2026-09-14-gale-import/README.md:3-19,41-43`).
17. The product sheet stores imported Amazon values per language in `ChannelListingTranslation.attributes` (content writer `services/pim/content-write.ts`); the content resolver never reads outbound `platformAttributes` (`content-resolver.ts:210`).
18. Native `.xlsm` export exists only from the Amazon flat-file page (vault base, `services/amazon/template-vault.service.ts:284`; `::record_action` blank, FBA qty never); the eBay File Exchange export is missing (`docs/pes-parity-audit.md:451`).
19. Every earlier round-trip proof is in the Nexus format (335 values, 62,731 rows) (`docs/2026-09-05-catalog-transfer.md:47,78`).
20. The one price door `writeChannelPrices` requires `expectedVersion` and ENQUEUES a `PRICE_UPDATE` push (`services/pim/channel-price-write.service.ts:70,132,244,282`).

## §1 The corpus (measured, read only) — `records/2026-09-24-corpus.md`

89 spreadsheets: **55 Amazon NEW templates** (34 in `FINAL (upload this)` folders: 8 jacket families × IT/DE/FR/ES + GALE IT `.xlsx` + X-RACING IT),
**12 Amazon OLD flat files** (keys row 3; their D1 cell holds `settings=` with market and language; formulas only in price/size columns
of 6), **10 of our eBay workbooks** (`ebay_it`, 79 columns), **6 root `XAVIA-eBay-IT-<FAMILY>`** (sheet named by family, 66 columns, no Item
IDs, one listing), **2 `amazon_OUTERWEAR_IT`** (a flat SP-API style sheet, not a template), 4 lock files.
Facts that shape the plan: 25 of 34 FINAL Amazon files leave `::record_action` blank and their template default is **full update**;
delete rows exist (`Löschen`, `Löschung`, `Elimina` — 5 files); the same SKUs appear in older copies with 331–2,986 different cells;
**the Amazon parent SKU differs by market** (MOSS: `IT-MOSS-JACKET` in IT, `MOSS-JACKET` in DE/FR/ES; MISANO DE/FR/ES use Amazon-made
SKUs); eBay Item IDs are blank on most rows of 6 of 10 files; GALE IT `.xlsx` is Strict OOXML.

## §2 What the existing paths do with it (measured on a private DB copy) — `records/2026-09-24-results.md`

| | Amazon NEW (FINAL 34) | Amazon OLD (12) | our eBay (10) | root XAVIA eBay (6) |
|---|---|---|---|---|
| product-sheet drawer | ❌ `.xlsm` refused; `.xlsx` times out at 91 s | ❌ | ⚠ 4 read, **0 can be applied**; 6 refused whole | ❌ not recognised |
| catalog page | ✅ 33 read (X-RACING not measured) | ❌ 12/12 refused whole | ❌ (wrong door) | ❌ |
| filled cells | 62,249 → **54,207 imported (87.1 %)**, 7,802 kept out, 240 refused | — | see `coverage-ebay.md` | — |
| blank cell | always "no change" — also on full-update rows | — | "no change" | — |
| record action | IT/FR/ES partial ✅ · **German partial ❌ every row** · delete ❌ | not read | `Action` unused | — |
| parent / child | kept out for existing products; a mismatched parent SKU **creates a duplicate parent** | — | must match exactly | — |
| variation theme | ✅ imported (`FORMATO/COLORE` → `SIZE/COLOR`) | — | ✅ | — |
| ASIN / EAN | ASIN ✅ (655 cells) · EAN/GTIN kept out (none in FINAL files) | — | no EAN/MPN cell filled in the 4 files read | — |
| images | ✅ 5 locator slots + main | — | ✅ Image 1–6 as one list | — |
| price | ❌ kept out (1,778 cells) | — | ❌ kept out | — |
| quantity | ❌ kept out (correct: EU one number, FBA never) | — | ❌ kept out | — |
| language | ✅ DE/FR/ES stored in their own language — except a NEW product's Shared name | — | ✅ `it` | — |
| **can be applied** | **5 of 14 sampled reviews** (one refused cell blocks the whole file) | 0 | **0** | 0 |

Round trip (GALE IT, applied on the copy): **product sheet → its own export: 955/955 values equal** (a planted change is caught).
**Amazon flat-file page → native .xlsm export: none of the 913 imported changes appears** — two stores (§0 line 17–18).
Safety: picking File type "Nexus workbook" for an Amazon `.xlsx` on the catalog page ran **> 8 min on the API's main thread** (killed) —
the 2026-09-16 production-wedge class.

## §3 Why these gaps matter

The goal is general (every family, format, market, action) and "zero loss". Today: the old format and all eBay-without-Item-ID files
cannot enter; one refused cell stops a whole file; a German partial file, a delete file or a two-language file is refused whole; a
market-specific Amazon SKU makes a duplicate product; prices never arrive; and the Amazon flat-file page never sees an import.

## §4 AMENDMENT CFI-A1 — FOR YOUR RULING (nothing is built before the Owner rules)

**Engine, chosen on purpose: catalog-transfer** (the product sheet's engine) for both doors. Why: it never publishes; it has a preview
with per-record versions; it writes the one store the product sheet reads (R1 "one field, one writer, one store"); its round trip is
955/955. Not FX: its save enqueues price/quantity pushes (`amazon-flat-file.routes.ts:1557-1600`). Not FF2: no web caller.
**No change** to the legacy import-wizard, FF2, or the flat-file editors. Every change is generic (driven by the file's keys and the
category schema); no per-family code.

| step | what | main files (named in `docs/pes-claims.md` before the first edit) |
|---|---|---|
| **CFI-1 Safety + one door** | A cheap jszip "sniff" recognises the 5 corpus shapes (Amazon new/old, our eBay by its headers whatever the sheet name, Nexus workbook, other) and sends the file to the right reader, whatever File type was chosen. ExcelJS never opens an Amazon template. The catalog page preview moves onto the parse worker (heap cap, 90 s). The drawer accepts `.xlsm`. | new `services/pim/channel-file-sniff.ts`; `workbook-parse.worker.ts`, `workbook-parse-protocol.ts`, `catalog-editor-workbook.ts`, `routes/catalog-transfer.routes.ts`; web drawer + catalog page |
| **CFI-2 Amazon reader, every shape** | Record-action words from the template's own dictionary (settings aliases + `AttributeDefaultValues`), not a hand list — fixes German partial/delete. OLD files: market + language from D1 `settings=`, classic keys through the existing legacy key map, a formula cell uses the value Excel saved (flagged "from a formula"). A second-language column goes to that language when the market carries it; otherwise only that column is refused. Amazon's example row is skipped with a reason. The 60 PANTS refusals: find and fix the cause. Brand/condition are imported even when read-only on Amazon (they are what Amazon holds). | `services/amazon/template-workbook.ts`, `services/pim/catalog-amazon-workbook.ts` |
| **CFI-3 Record actions honoured** *(Q1)* | partial: blank = no change · full: a blank cell in a column the file carries clears that market value · delete: the market listing is marked ended in Nexus, the product stays, nothing is sent. Each shown in the preview before any write. | `catalog-amazon-workbook.ts`, `catalog-transfer-plan.ts` |
| **CFI-4 Identity** | Match by SKU → ASIN / Item ID → the channel's own SKU for that market (new additive column `ChannelListing.channelSku` + baseline). An unmatched row is never a silent new product: the preview proposes the link (by ASIN / children) or "create", and the Owner ticks it. A new product never gets a non-Italian Shared name. Creating a new market listing from a file works (today "Content listing does not belong"). A SKU twice in one file is refused with both rows named. | `catalog-amazon-workbook.ts`, `catalog-ebay-workbook.ts`, `catalog-transfer-plan.ts`, `catalog-transfer.service.ts`, `content-resolver.ts`, `packages/database` schema + `generate-baseline.mjs` |
| **CFI-5 eBay, every family** | Recognised by headers (the 6 root files). Blank Item ID → match by SKU + market + parent; a present Item ID must agree. `-ALT` listings link to existing aliases, else shown as "not in Nexus" with the existing adopt step. `⚠` custom item specifics imported as custom specifics. A value outside eBay's list is kept with a warning. Catalog page accepts eBay files for many families. | `catalog-ebay-workbook.ts`, worker, routes |
| **CFI-6 Price and quantity** *(Q2)* | Price: file vs Nexus in the preview, written through the one door `writeChannelPrices` (`expectedVersion` required) in a new **record-only** mode — it writes and audits, and enqueues NO push, because the price came from the channel. Quantity: never imported (EU one number, FBA never); shown for information. | `channel-price-write.service.ts` (a flag; coordinate with R-11), `catalog-transfer.service.ts` |
| **CFI-7 Apply what is valid** | Today one refused cell makes the whole review INVALID (`catalog-transfer-jobs.ts:266,335`). New: "Apply N ready records" with one explicit confirmation; the M refused stay listed with reasons and an error file. | `catalog-transfer-jobs.ts`, web `TransferReview.tsx` |
| **CFI-8 Truthful preview** | Per product, per field: file · Nexus · channel (last read from ChannelDrift / the nightly content read, with its time) and the language. "The channel differs from the file" is flagged (a file can be older than live). Design system components only; 7:1; keyboard; light/dark. | web `catalog-transfer/TransferReview.tsx`, `previewColumns.tsx`, drawer review; outcome rows gain the channel value |
| **CFI-9 Corpus proof** | A committed script runs all 89 files on a DB copy: sniff → parse → preview → apply → product-sheet export → compare. Per file every filled cell is imported, kept out with a written reason, or refused with a reason — 0 unexplained; imported values round-trip 100 %; a planted change is caught. Then per-run production imports only with the Owner's word (read → preview → write → read back → restore path → delayed re-read). | `apps/api/scripts/cfi-corpus-proof.mts`, `docs/channel-file-import/records/` |

**Closure fields (all steps).**
- **Done when** — CFI-1: 89/89 files sniffed as the corpus table; the Amazon `.xlsx` wrong-door case answers in < 5 s; no ExcelJS on any Amazon file. CFI-2: 67/67 Amazon files parse with 0 whole-file refusals. CFI-3–7: the 14 sample reviews + all 16 eBay files reach a review that can be applied, every refusal has a reason the Owner can act on. CFI-8: the review shows the three values on the 14 samples (screenshots, light/dark). CFI-9: the corpus report = 0 unexplained, 100 % round trip, control caught.
- **Cost when** — per file, bounded by the existing 10 MB / 50,000-outcome limits; CFI-9 must finish the whole corpus in < 15 min; CFI-8's channel read is one indexed query per review page (flat at 10,000 products).
- **Gate** — vitest per step from `apps/api` (fixtures = trimmed copies of corpus shapes, never the Owner's originals); mutation-proved (a green no-mutation control first; each fix removed → its test fails); the CFI-9 corpus run after every step; fresh private tsbuildinfo typecheck; web gates for CFI-7/8.
- **Rollback** — each step is one commit and reverts alone; the only schema change (CFI-4) is additive; CFI-6's flag defaults to today's behaviour.

**Named, NOT in this amendment:** E-1 — native export (Amazon `.xlsm`, eBay workbook) built from the product-sheet store, and the
Amazon flat-file page reading that same store. Until E-1, **an import does not change what the flat-file page shows or exports**
(round trip B). Order: CFI-1 → 2 → 4 → 3 → 5 → 6 → 7 → 8, with CFI-9 run after each; lanes with disjoint files (Amazon reader ·
eBay reader · jobs/plan · web).

### The two questions

**Q1 — Record actions.** 25 of the 34 FINAL Amazon files are "full update" (create or replace). On Amazon, a blank cell in such a
row REMOVES that value; a delete row removes the listing.
- **(a) Honour the file** — full update: a blank clears the Nexus value for that market; delete: Nexus marks that market listing ended.
  All shown in the preview first; nothing is sent. 🟢 **Recommended** — it is the only way Nexus ends up equal to Amazon.
- (b) Keep today's rule — a blank never clears; delete rows are skipped.

**Q2 — Prices.** Files carry 1,778 price cells (list price and your price, with tax). Today no import writes a price.
- **(a) Import them through the one price door in a new "record only" mode** — Nexus stores the channel's price, and nothing is sent
  back (so the known Amazon sale-price wipe on a price push cannot happen). 🟢 **Recommended.**
- (b) Keep prices out; the preview only shows "file price ≠ Nexus price".

### Rulings

| # | amendment | ruling |
|---|---|---|
| **R-CFI-1** | CFI-A1 (§4), Q1, Q2 | ✅ **Approved as recommended** — Q1 (a) honour the file's record action (full: a blank clears the market value; delete: the market listing is marked ended; nothing sent); Q2 (a) prices through the one price door in record-only mode (no push). The Owner, 2026-09-24 ~23:45: *"Yes, I agree with you. Go ahead with your recommendation."* |
