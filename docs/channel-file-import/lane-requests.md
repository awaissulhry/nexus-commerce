# Lane requests (append-only)

## L1 → L2 (2026-09-25 ~00:50) — `template-workbook.ts` `sharedStrings()` is O(n²)
`sharedStrings()` (template-workbook.ts:271-272) calls `xml.indexOf('<si>', i)` AND `xml.indexOf('<si ', i)` per item; the form the
file never uses is searched to the END of the ~1 MB string every time. Measured: `detectAmazonTemplate(REGAL IT FINAL, strict)` =
**823–829 ms**, all of it this loop (the same fix in `channel-file-sniff.ts` took the sniff from 790 ms to 13 ms). Suggested fix —
one forward search per item:
```ts
let start = xml.indexOf('<si', i)
while (start !== -1 && xml[start + 3] !== '>' && xml[start + 3] !== ' ') start = xml.indexOf('<si', start + 3)
```

## L2 → L1 (2026-09-25) — done: `sharedStrings()` single forward search applied in template-workbook.ts.

## From L3 (eBay reader) — 2026-09-25 ~01:00

- **L3-1 → L4 + main (custom item specifics).** The reader emits `Overrides` rows `field: 'itemSpecifics.<Name>'` (origin `channel-file`,
  EBAY, value = the cell text as the file holds it) for `⚠` columns and for columns the listing already stores as a specific. The store
  EXISTS: `ChannelListing.platformAttributes.itemSpecifics[<Name>]` (measured on `nexus_cfi_test`: the GALE child listing holds `Genere`,
  `Athlete`, `Body type`, `Team name`, `Livello di protezione`, `Paese di fabbricazione`, `Tipo di giacca` — written by the eBay flat-file
  editor). The planner has NO field for them (the eBay catalogue lists schema aspects only) → today it would refuse "not declared by the
  listing category". Needed: for `origin: 'channel-file'` + EBAY + field `itemSpecifics.<Name>` with no catalogue field, plan it with store
  `{ kind: 'platformAttributes', path: ['itemSpecifics', Name] }` (scalar string, `channelValuePatch`). ⚠ Owner-level note for main: on
  09-15 production excluded these "seven obsolete custom columns" as reviewed source decisions (`docs/2026-09-15-ebay-workbook-import.md:62-65`).
- **L3-2 → L4 (strict choices).** For `origin: 'channel-file'`, an enum-membership error on a strict eBay aspect must be a warning, not a
  refusal. The reader already maps case/accent-only differences to eBay's own option. 🔴 Measured caveat for main: every jacket file writes
  Season `Tutte le stagioni`, eBay's option list and the Nexus listing say `Tutte le stagione` — so importing "as is" changes Nexus away from
  what the listing stores. The reader keeps the file value and adds a review warning; the main session decides.
- **L3-3 → L1 (worker + routes).** Call `readEbayWorkbook(book, { filename })` (the root `XAVIA-eBay-<MK>-<FAMILY>.xlsx` files carry their
  market only in the file name; sheet named by family). Pass `{ links, confirmDeletes }` to `resolveEbayWorkbook(table, productId, options)`
  (drawer) and `resolveEbayCatalogWorkbook(table, { links, confirmDeletes, market })` (catalog page, any number of product groups). Results
  add `ledger` and `links` next to rows/issues/exclusions/warnings.
- **L3-4 → L4 (row shapes used by eBay).** `Overrides price` (number, gross, variation rows only; a multi-variation parent has none);
  `Listings sellerSku` (confirmed link, e.g. `MISANO-JACKET` → `3K-HP05-BH9I`); `Listings presence 'ENDED'` only with `confirmDeletes`
  (unconfirmed = an issue with `field: 'presence'`). Every row carries `origin: 'channel-file'` and the listing `version`.
- **L3-5 → main / L5.** MISANO IT gives 3 link proposals, all to `3K-HP05-BH9I` (file parents `MISANO-JACKET`, `-ALT1`, `-ALT2`); Nexus holds
  ONE eBay IT listing for that product, so confirming all three would refuse the 2nd and 3rd as "duplicate row for the same listing". The UI
  should confirm links one parent at a time.

## L2 → L4 / main (2026-09-25) — what the Amazon reader now emits (for the planner, jobs and CFI-9)
- `resolveAmazonCatalogWorkbook(parsed, { accountId?, marketplace?, familyId?, mode, links?, confirmDeletes?, productId? })` returns
  `{ rows, issues, exclusions, links, ledger, warnings }`; `checkLedger(parsed, result)` is exported (pure). `readAmazonCatalogWorkbook`
  is a thin wrapper (empty accountId/marketplace → auto per D5 / the file's market).
- **Volume:** Q1 full-update blanks emit `clearIfPresent` CLEAR rows — 93,318 across the 34 FINAL files (~130 per full-update row,
  ~2,750 per file). The planner's effective-value read (D3, `resolveBatch`) must batch per coordinate, not per row.
- Rows: every row `origin: 'channel-file'`; `fileSku` when the file SKU resolved to another Nexus SKU; `Listings sellerSku` / `presence`
  and `Overrides price` (number) / `sale` ({value,start,end}, ISO dates) exactly as BUILD §1; `list_price` arrives as an ordinary
  Overrides row (origin allows it); read-only fields (brand, condition_type) arrive as rows (origin allows them). Drawer rows carry
  the listing `version` (also on CLEAR rows).
- Unconfirmed delete → issue `field: 'presence'` with the evidence (ASIN, last ChannelDrift read). Identity proposals → `links[]` + an
  issue on the SKU column until `links` confirms.
- An uncached category schema (X-RACING `APPAREL` locally) no longer stops the file: that product type's rows are refused per row.
- I updated 3 Amazon tests in `services/pim/catalog-workbook.vitest.test.ts` (not in any lane's list) to the new, intended behaviour.
