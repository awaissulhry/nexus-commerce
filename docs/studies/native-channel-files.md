# Native channel files — eBay bulk template and Shopify product CSV (study)

**Status: STUDY ONLY. Nothing is built. Three decisions for you (§5.3).**
Written 2026-09-26. Worktree `/private/tmp/nexus-channel-mappings`, branch `feat/native-channel-files`, from `origin/main`
`074c1cf54`. Builds on the channel-mappings study (`docs/studies/channel-mappings.md`, "CHMAP", §8 and §11).

Labels: **read** = seen in code or on a page · **inferred** = follows from the code, not run · **NOT VERIFIED** = no
official page or file states it; the Owner's sample files (§4.2) settle it. No production data was read. No real item
number, policy, store or seller id appears here.

## Summary (for the Owner)

1. **eBay's own bulk file** is the one Seller Hub → Reports → Uploads gives you: one row per listing, one more row per
   variation. Its first cell names the site (Italy), the country, the currency and the template version.
2. **"All active listings"** is a smaller eBay file: item number, SKU, title, price, quantity and variations only.
   It has no description, photos or item specifics.
3. **Shopify's own file** is Products → Export in the Shopify admin: one row per variant, plus rows for extra photos.
   The "URL handle" column ties the rows of one product together.
4. **Import** reads either file, matches every row to a product and listing Nexus already has, and shows a preview.
   Nothing is saved until you press Apply. A production import needs your word each time.
5. **Import saves:** titles, descriptions, item specifics and metafields, condition, SEO text, weights, policies.
   Prices are recorded only; nothing is sent back to the channel.
6. **Import never saves:** stock quantity, whether a listing is live or ended, the variation structure, Shopify
   photos, or anything for a product Nexus does not know. Each such cell is shown with its reason.
7. **Export** writes the same file shape from what Nexus holds, ready to upload to eBay or Shopify, as a change to
   listings that already exist. It never writes stock.
8. **The traps:** eBay drops item specifics you leave out of a revision; Shopify erases a value when a cell is blank
   and deletes variants when the option columns are missing. The export is built around both (§1.5, §2.4).
9. Every import and export records the mapping version it used, as the Amazon and eBay files do today.
10. Tests use your real files (kept private) and anonymised copies in the repository (§4).

---

## 0. What exists today (read)

- **Channel file import (CFI) reads two channel shapes, both Excel:** Amazon's template and **our own** eBay workbook
  (`pim/catalog-ebay-workbook.ts:81`, `mapEbayWorkbook` `:137`). The sniffer opens zip workbooks only
  (`pim/channel-file-sniff.ts:160-164`); any `.csv` is "other".
- **A `.csv` upload today means the Nexus attribute CSV.** The parse worker sends every non-Excel file to
  `readTransferFile` (`pim/workbook-parse.worker.ts:54`), which refuses unknown headers (`pim/catalog-transfer-file.ts:67-68`).
  So an eBay or Shopify CSV is refused with "Unknown columns: …" (inferred, not run).
- **Mapping versions (CHMAP)** exist for three forms: `AMAZON_TEMPLATE`, `AMAZON_FLAT_FILE`, `EBAY_WORKBOOK`
  (`packages/shared/channel-mapping.ts:14`), channels `AMAZON` and `EBAY` only (`:10`). Export by version is on the File
  mappings screen (`routes/channel-mapping-sets.routes.ts:91-109`).
- **One old eBay CSV export exists**, with no import: the cockpit "File Exchange" CSV
  (`routes/ebay-cockpit.routes.ts:718-830`). It writes `Add` rows under a plain `Action` header (no site metadata) and
  writes each variation's **quantity** from the listing (`:810`), against CHMAP's "stock is never written into a file".
- **Shopify: no CSV code.** A search for `Variant SKU`, `Body (HTML)` and `Image Src` finds nothing Shopify-related.
  - A Shopify listing is `ChannelListing` channel `SHOPIFY`, marketplace `GLOBAL`, `channelConnectionId` = the store
    account. The product id is `externalListingId`; the variant id is `platformAttributes.variantId`
    (`shopify/channel-sheet.service.ts:141-146`).
  - Its fields are the registry in `packages/shared/shopify-information.ts:25-56` (title, descriptionHtml, tags, status,
    category, productType, vendor, price, compareAtPrice, cost, taxable, sku, barcode, inventory, inventoryPolicy,
    weight, requiresShipping, SEO title/description, URL handle …). Metafield columns come from the store's saved field
    list (`pim/channel-specs/shopify.ts:113-127`; keys `shopify-information.ts:61-67`). The 2026-09-24 metafields fix is
    described in `docs/product-cheat/SHOPIFY-METAFIELDS-PLAN-2026-09-24.md` (untracked, in the main checkout only).
  - **What Nexus pushes to Shopify today:** `productSet` with title, descriptionHtml, vendor, productType, tags, the
    options and the variants (SKU, price, compare-at price), media, then `metafieldsSet`
    (`shopify/content-publisher.ts:253-260`, `:302`). Linked listings send title, description, compliance metafields,
    price and stock (`shopify/listing-write.service.ts:1-17`).

---

## 1. eBay native bulk template

Sources (eBay's own pages; the two marked ✓ were re-checked by me on 2026-09-26):
- E1 ✓ Uploadable templates — https://pages.ebay.com/sh/reports/help/uploadable-file-feeds
- E2 Inventory onboarding guide (2024) — https://pages.ebay.com/sh/reports/help/create-listings-bulk/
- E3 Seller Hub Reports help — https://www.ebay.com/help/selling/selling-tools/seller-hub-reports?id=4096
- E4 How to upload listings in bulk (2024) — https://export.ebay.com/en/services-tools/seller-hub/uploading-your-listings-in-bulk-using-reports-tab/
- E5 ✓ File Exchange Advanced Instructions (2015) — https://pics.ebay.com/aw/pics/sg/pdf/file_exchange/mysg/File_Exchange_Advanced_Instructions.pdf
- E6 Italian edition (2015) — https://pics.ebay.com/aw/pics/it/pdf/file_exchange/File_Exchange_Advanced_Instructions.pdf
- E7 Downloadable reports guide (2021) — https://ir.ebaystatic.com/cr/v/c1/rsc/feeds/v1/guide-downloadable-reports.pdf
- E8 Feed API quick reference — https://developer.ebay.com/api-docs/sell/static/feed/fx-feeds-quick-reference.html
- E9 Trading API site codes — https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/SiteCodeType.html
- E10 ebay.it Reports help — https://www.ebay.it/help/selling/selling-tools/seller-hub-reports?id=4096
- E11 File Exchange instructions (2008) — https://pics.ebaystatic.com/aw/pics/pdf/File_Exchange_Advanced_Instructions0908.pdf
- E12 ebay.it category 177104 — https://www.ebay.it/b/Giacche-e-giubotti-per-motociclista/177104/bn_16549005

### 1.1 Format facts

| Fact | Source |
|---|---|
| First cell: `*Action(SiteID=<site name>\|Country=<code>\|Currency=<code>\|Version=<n>\|CC=UTF-8)`; it "must always be contained in the first cell and first row". Header names are not case-sensitive. | E5 |
| **SiteID is a site NAME, not a number:** "if you want to list on the German site, make sure that SiteID=Germany"; the table lists Italy as `Italy`. `101` is the Trading API number for Italy (EUR). | E5 ✓, E9 |
| `Version` is the API version ("Do not alter these values"); pages show 403 (2008), 745 (2015), 1193 (2024). `CC` may be ISO-8859-1, GBK, Big5, CP1252 or UTF-8; every modern example uses UTF-8. | E5, E4, E11 |
| Actions: Add, VerifyAdd ("does not post the listing"), Revise, Relist, End (with an end code), Status, AddToItemDescription, Info; newer: Draft, and Delete on a variation row. | E5, E1, E2 |
| Revise needs Action, ItemID, the changed fields — and the "revision-dependent" fields: "Custom item specific fields (C:<value name>), shipping fields, and payment fields all have this dependency"; what is left out "will be dropped from your listing". | E5 ✓ |
| Clearing a field: a `DeleteFields` column (e.g. `Category2\|Subtitle`). "Blank cell = unchanged" is never stated (**NOT VERIFIED**; implied by "changed fields only"). | E5 |
| `*` marks a required field. Current templates flag missing values by colour (red = required, yellow = soon required, blue = recommended). | E5, E4 |
| Item specifics: "The field name must begin with C:", e.g. `C:Style`. Multi-value separator inside a `C:` cell: **NOT VERIFIED** (E5's general rule is `\|`). | E5 ✓ |
| Identifiers: `P:EAN`, `P:UPC`, `P:ISBN`, `P:EPID` (older files: `Product:EAN` …). No barcode → "Does not apply" (E1, E2); E4 says "Not applicable". The Italian value in a file: **NOT VERIFIED**. | E2, E5 |
| Variations: `Relationship` empty on the parent row, `Variation` on each child; `RelationshipDetails` = `Taglia=S;M;L\|Colore=Nero` on the parent, `Taglia=M\|Colore=Nero` on a child; "Do not add blank spaces … or the upload will fail". Quantity and price are on child rows only; title and description on the parent only. | E2, E4 |
| A child row finds its parent **by row order** (it follows the parent). A variation is identified "by RelationshipDetails (and CustomLabel field if present)". | E2, E5 |
| Pictures: `PicURL`, URLs separated by `\|`, `https://`, spaces as `%20`. Limit 12 (E2, E5) or 24 (E1) — eBay's pages disagree. On a child row: `Colore=URL1\|URL2` for one trait only. | E1 ✓, E2, E5 |
| Description may not contain new lines ("use `<br>` or `<p>`"); up to 500,000 characters. `CustomLabel` up to 50 characters; parent and child SKUs must differ. | E5, E2 |
| Policies are given by **name** (`ShippingProfileName`, `ReturnProfileName`, `PaymentProfileName`), "case-sensitive", up to 50 characters. | E2, E5 |
| `ConditionID` is numeric (1000 new … 7000 for parts). | E2 |
| Category template: Reports → Uploads → Download template → "Create new listings", one to five categories (E1) or up to ten in XLSX since June 2024 (E2); `.csv` or `.xlsx`. `#INFO` rows at the top "remain on the file". | E1 ✓, E2, E3, E10 |
| **"All active listings" = the "Edit price and quantity" template**, not a full listing file: #INFO, Action (Revise), Item number, Title, Listing site, Currency, Start price, Buy It Now price, Available quantity, Relationship, Relationship details, Custom label (SKU); variations included. | E1 ✓ |
| No eBay download gives complete listings (description, pictures, item specifics) in the template shape. The "Active listings report" lacks them too. | E7, E1 |
| Italy: IT files were "Semi-colon delimited" in 2015, with decimal commas in the example (`1,99`). Today's delimiter and decimal mark: **NOT VERIFIED**. | E5 ✓, E6 |
| Limits: 15 MB per file (2015); 14.9 MB and 150,000 lines per file today per an eBay tools-team forum reply (not a help page). BOM allowed or not: **NOT VERIFIED**. | E5, community |
| The Feed API uploads the same templates (`FX_LISTING`); no sandbox. | E8 |
| Category 177104 on ebay.it: "Giacche e giubbotti" under "Abbigliamento per moto"; leaf status **NOT VERIFIED**. | E12 |

**Literal header names in today's files are NOT VERIFIED.** eBay's current pages use display names ("Custom label
(SKU)", "Item photo URL"); the 2015 guide uses `CustomLabel`, `PicURL`. The reader keeps both spellings as aliases; the
sample files (§4.2) decide which the export writes.

### 1.2 How each column maps onto Nexus

Targets reuse what our eBay workbook already uses (`channel-mapping/defaults.ts:91-118`, the eBay spec
`pim/channel-specs/ebay.ts:103-140`). An aspect column keys as `aspect:<localized name>` exactly like the workbook
(`channel-mapping/ebay-draft.ts:40-54`), so `C:Marca` and the workbook's `Marca` are the same column.

| Native column (2015 name / display name) | Nexus target | Import | Export |
|---|---|---|---|
| `*Action(…)` | record action + the file's site | SiteID/Country → market (Italy → IT); `Version` → the version's `templateVersion`. End/Delete → the existing "confirm, nothing sent" rule (`catalog-ebay-workbook.ts:201-230`) | `Revise` (§1.5) |
| `ItemID` / Item number | listing identity | must equal the Item ID Nexus holds (same rule as `:177-185`) | from the listing |
| `CustomLabel` / Custom label (SKU) | row identity | matched, never overwritten | the SKU |
| `Relationship`, `RelationshipDetails` | parentage (managed) | parent from row order; details checked against the family's axes; a child's values become that variation's item specifics for the axis names | from the axes, with the eBay renames the cockpit already reads (`ebay-cockpit.routes.ts:743-744`) |
| `Category` / Category ID | `categoryId` (Listings) | as the workbook | written |
| `Title`, `Subtitle`, `Description` | `title` (≤ 80), `subtitle` (≤ 55), `description` | as the workbook | written; new lines become `<br>` |
| `ConditionID` | `conditionId` | 1000 → `NEW` etc. through `services/ebay-condition.ts:15-32` | enum → number (same table) |
| `C:<name>` | the category aspect, else the seller's own specific | as the workbook (`catalog-ebay-workbook.ts:265-292`) | **all of a listing's specifics** (§1.5) |
| `P:EAN`, `P:UPC`, `P:ISBN`, `P:EPID` | product identifier (managed) | reference only, like the workbook's `EAN` (`:285`) | not written on Revise |
| `StartPrice` / Start price | the one price door | record-only (`catalog-transfer.service.ts:309-311`); a multi-variation parent has no price; decimal comma accepted | the listing price, with the export's "include prices" switch |
| `Quantity` / Available quantity | stock ledger | **never imported** | **column left out** |
| `PicURL` / Item photo URL | `imageUrls` | split on `\|`; a child's `Trait=URL\|URL` → that variation's pictures | from `imageUrls`, capped at 12 until the limit is measured |
| `Format`, `Duration` | `listingFormat`, `listingDuration` | `FixedPrice` ↔ `FIXED_PRICE`, `GTC` ↔ `GTC` | written |
| `DispatchTimeMax`, `VATPercent`, `Country` | `handlingTime`, `vatRate`, `itemLocationCountry` | as the workbook | written |
| `ShippingProfileName`, `ReturnProfileName`, `PaymentProfileName` | `fulfillmentPolicyId`, `returnPolicyId`, `paymentPolicyId` | name → id through the account's policy list (`pim/reference-values.service.ts:34-42`); an unknown or duplicate name is refused, never guessed | id → exact name |
| Best Offer columns (names **NOT VERIFIED**) | `bestOffer`, `bestOfferFloor`, `bestOfferCeiling` | as the workbook | written |
| `Location`, `PostalCode`, shipping-service and return-detail columns | none today | **unmapped** until you decide on the File mappings screen | not written |

### 1.3 What import writes and refuses

- **Writes** (after the preview and Apply): the listing fields above on the eBay listing Nexus already holds, per
  variation where the file gives per-variation values. Prices go through the price door, record-only.
- **Excludes, each cell with its reason:** quantity, identifiers, listing identity, Action/lifecycle.
- **Refuses:** a row whose SKU or Item number Nexus does not hold ("create it first", `:183-184`); a listing named twice;
  a price that is not a number; a policy name that does not match exactly one policy; a category whose schema is not
  cached (`:199-200`); a column the version has not decided. Rows of a new listing (`Add`) are refused: a new listing
  is created in Nexus first.
- **"All active listings"** imports identity checks, title and price (record-only). Quantity is excluded.

### 1.4 eBay Italy

- Header: `SiteID=Italy|Country=IT|Currency=EUR` (E5, E9). The reader also accepts `SiteID=101`, since the code's own
  table uses numbers (`ebay-trading-api.service.ts:12-18`), but the export writes `Italy`.
- Aspect names are Italian (`C:Marca`, `C:Taglia`, `C:Colore`), matched by the IT category schema, as the workbook does.
- The delimiter (`,` or `;`) is read from the header (`pim/catalog-csv-dialect.ts:17-30`). A decimal comma is not
  accepted by today's workbook price rule (`catalog-ebay-workbook.ts:247`); the native reader needs its own number
  rule for IT files. The export writes whatever the sample file uses (§4.2).

### 1.5 What export writes

- **One `Revise` row per listing Nexus holds with an Item number**, then its variation rows. Header: the site
  metadata cell, the `#INFO` rows copied from the stored template, then the version's columns in order.
- **Only changed-or-mapped columns.** Revise needs only Action, ItemID and the fields sent (E5), so stock, identifiers
  and every unmapped column are **left out of the file**, not written blank. This is how a CSV makes a partial update.
- **Item specifics are all-or-nothing per listing.** Because eBay drops the specifics a Revise leaves out (E5), a
  listing is written with **every** specific it holds: Nexus's values plus the specifics stored from eBay's last read
  (the workbook export already merges them, `channel-mapping/ebay-export-host.ts:53-54`). A listing whose specifics
  Nexus has not read back from eBay is not exported; the summary names it.
- **Policies by name**, looked up from the ids at export time; a missing name stops that listing.
- **New listings (no Item number) are not written** — your decision D1 (§5.3).
- **Never written:** quantity, Action words other than Revise, identifiers on Revise.

---

## 2. Shopify product CSV

Sources (Shopify's own; S1 re-checked by me on 2026-09-26):
- S1 ✓ Using CSV files — https://help.shopify.com/en/manual/products/import-export/using-csv
- S2 Import — https://help.shopify.com/en/manual/products/import-export/import-products
- S3 Export — https://help.shopify.com/en/manual/products/import-export/export-products
- S4 Sample file — https://help.shopify.com/csv/product_template.csv
- S5 Common import issues — https://help.shopify.com/en/manual/products/import-export/common-import-issues
- S6 Variants — https://help.shopify.com/en/manual/products/variants/add-variants
- S7 Inventory CSV — https://help.shopify.com/en/manual/products/inventory/setup/inventory-csv
- S8 Product category — https://help.shopify.com/en/manual/products/details/product-category
- S9 Barcodes changelog (2026-09-08) — https://changelog.shopify.com/posts/multiple-barcodes-in-variants
- S10 `productSet` — https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet

### 2.1 Format facts

| Fact | Source |
|---|---|
| **The column names changed.** Today's sample has 57 columns: Title, **URL handle**, **Description**, Vendor, Product category, Type, Tags, **Published on online store**, Status, **SKU**, Barcode, Option1 name/value/Linked To (×3), **Price**, **Compare-at price**, Cost per item, Charge tax, Tax code, 4 unit-price columns, Inventory tracker, Inventory quantity, Continue selling when out of stock, Weight value (grams), Weight unit for display, Requires shipping, Fulfillment service, **Product image URL**, Image position, Image alt text, Variant image URL, Gift card, SEO title, SEO description, a category metafield, Google Shopping columns. | S4 |
| The old names (`Handle`, `Body (HTML)`, `Published`, `Variant SKU`, `Variant Price`, `Image Src` …) still appear on S5, and Shopify "maintains backward compatibility with older column names". No official old → new table exists. | S1, S5 |
| Barcode header is unsettled: `Barcode` (sample), `Barcodes` (help page; "can't have both"), `Variant Barcodes` (changelog). | S4, S1, S9 |
| Headers are case-sensitive. The `Collection` column and metafield columns are the only additions allowed. | S2, S1 |
| Required: Title for a new product; **URL handle and Title** when updating. | S1 ✓ |
| Matching products are updated only with "Overwrite products with matching handles" ticked; otherwise "ignored". | S1, S2 |
| **An omitted column keeps the value; a blank cell erases it:** "If a non-required column in the import CSV file is blank, then the matching value … is overwritten as blank." | S1 ✓ |
| **Missing option columns delete variants:** without Option1 name/value "a new default variant is created and existing variants are deleted". Changing an option value "deletes existing variant IDs, and creates new variant IDs". | S1 |
| Variants: several rows per handle; the first row carries the product fields; up to 3 options; up to 2,048 variants; a product over 100 variants is exported by email. | S1, S6, S3 |
| Images: one extra row per image with only handle + URL; up to 250; public `https://` URLs; Shopify downloads and re-uploads them; video and 3D not supported. | S1 |
| Metafield header: `Name (product.metafields.<namespace>.<key>)`; list values separated by `; `; a closed list of supported types. **"Variant metafields aren't supported for product CSV import/export."** | S1 ✓ |
| Inventory quantity is "used only for stores that have a single location"; several locations use the separate inventory CSV. | S1 ✓, S7 |
| Status: `active` (default), `draft`, `archived`; "If the column isn't present, then the product status is automatically uploaded as `active`." Published: `true`/`false`. | S1 |
| Product category: the full breadcrumb or the category ID (e.g. `hg-15-1-2`), "but not both". | S8, S1 |
| Market columns: `Included / <market>`, `Price / <market>`, `Compare-at price / <market>` named after each market. | S1 |
| Export: current page / all products / selected / search results; "CSV for Excel, Numbers, or another spreadsheet program" or "Plain CSV file" — **no technical difference is documented**. | S3 |
| Encoding: "UTF-8 format using LF-style linefeeds"; the sample itself has no BOM and CRLF endings; import limit 15 MB. | S1 ✓, S4, S2 |

### 2.2 How each column maps onto Nexus

Targets are the Shopify registry fields (`shopify-information.ts:25-56`) under their mapping keys (`:61-67`: `sku` →
`listing_sku`, `seo.title` → `seo_title`). The reader accepts the old and the new header names.

| Column (new / old) | Nexus target | Import | Export |
|---|---|---|---|
| URL handle / Handle | `handle` + row grouping | identifies the product (§2.3) | always (required) |
| Title, Description (Body (HTML)), Vendor, Type, Tags | `title`, `descriptionHtml`, `vendor`, `productType`, `tags` | mapped | written on the first row |
| Product category | `category` (`gid://shopify/TaxonomyCategory/<id>`, `channel-specs/store.ts:42`) | ID → gid; a breadcrumb needs the taxonomy lookup | the ID |
| SKU (Variant SKU) | row identity + `listing_sku` | matched, never renamed from a file | always (with the options) |
| Option1–3 name/value, Linked To | variation axes (managed by the Products sheet) | checked against the family; never changed | **always**, with Shopify's current values |
| Price (Variant Price) | the one price door | record-only | the listing price, with "include prices" |
| Compare-at price | decision D2 | D2 | D2 |
| Cost per item | product cost (managed) | reference only | left out |
| Barcode(s) | `barcode` | mapped | written |
| Charge tax, Requires shipping, Continue selling when out of stock | `taxable`, `requiresShipping`, `inventoryPolicy` | mapped | written |
| Weight value (grams) + Weight unit for display | `weight` (measure) | one value with its unit | written |
| Inventory quantity, Inventory tracker, Fulfillment service | stock (ledger) | **never imported** | **left out** |
| Status, Published on online store | listing lifecycle | reference only | Status **always** written with the value Nexus last read (a missing Status may become `active`, S1); Published left out |
| Product image URL, Image position/alt text, Variant image URL | media workspace (`pim/channel-specs/store.ts:70`) | reference only | left out (Shopify keeps its media) |
| SEO title, SEO description | `seo_title`, `seo_description` | mapped | written |
| `… (product.metafields.ns.key)` | the store's metafield field | typed by the saved store schema; lists split on `; ` | written for mapped ones |
| Market price and Included columns, Google Shopping, Gift card, Tax code, unit price, Collection | none | ignored with a reason (or unmapped until you decide) | left out |

### 2.3 What import writes and refuses

- **The store is chosen on upload** (a Shopify CSV names none). In the product sheet it is the family's Shopify store
  when there is exactly one, as the eBay market is chosen today (`catalog-editor-workbook.ts:103-106`).
- **Identity:** each handle names one Shopify product; each SKU row one variant. The product must be a Shopify listing
  Nexus holds for that store (`externalListingId`), and each SKU a variant of it (`platformAttributes.variantId`, or the
  SKU when the id is absent). A handle Nexus does not know, but whose SKUs all belong to one Nexus family, becomes a
  **link proposal** you confirm (the CFI-4 pattern, `catalog-ebay-workbook.ts:379-387`). An unknown SKU is refused.
- **Writes** the mapped product fields on the family's Shopify listing and the variant fields on each variant's listing.
  Price is recorded only.
- **Never writes:** inventory, status, publication, media, options, variant metafields (the file cannot carry them, S1).

### 2.4 What export writes

- **Only for products Nexus already links in that store** (D1). You tick "Overwrite products with matching handles" on
  upload; the export summary says so.
- **Columns:** URL handle, Title, SKU, the option columns and Status always; then only the columns the ACTIVE version
  maps out. Stock, media, market and publication columns are left out, so Shopify keeps them (S1).
- **No blank cell in a written column:** a blank would erase Shopify's value (S1). If Nexus holds no value for a column
  on some row that needs one, that column is left out of the whole file and the summary names it.
- **Option values are written exactly as Shopify holds them.** A changed value would delete the variant and give it a
  new id (S1), breaking Nexus's link (`platformAttributes.variantId`). If Nexus's values differ from the last read,
  the export stops and says so.
- Headers use the new names (S4). Metafields use `Name (product.metafields.ns.key)`. Product metafields only.

---

## 3. Where each plugs into the code (read, `074c1cf54`)

| Hook | Where | Change |
|---|---|---|
| File kinds | `pim/channel-file-sniff.ts:29` (kinds), `:152-158` (labels), `:160` (zip only) | add `sniffCsv(bytes)`: header-only read with `readCsvDialect` (`pim/catalog-csv-dialect.ts:17`); kinds `ebay-bulk-template` (first cell `*Action(` / `Action(` or `#INFO` rows) and `shopify-product-csv` (URL handle/Handle + Title + SKU/Variant SKU or an Option column). The zip walk also learns the eBay template's `.xlsx` download (E10) |
| Parse worker | `pim/workbook-parse.worker.ts:54` | before `readTransferFile`, sniff the CSV and return the new outcomes |
| Outcome types | `pim/workbook-parse-protocol.ts:19-28` | `{ kind: 'ebay-bulk'; table }`, `{ kind: 'shopify'; table }` |
| Catalog page upload | `pim/catalog-editor-workbook.ts:245` (CSV skips the worker), `:262-266` (eBay branch) | route native CSVs through the worker; two new branches; Shopify needs the store |
| Product sheet import | `catalog-editor-workbook.ts:86-95` (`readEditorPart`), `:135` (market hint for Excel only) | two branches; store hint for Shopify |
| eBay reader | new `pim/catalog-ebay-bulk-csv.ts` next to `catalog-ebay-workbook.ts` | builds the table (parent from row order, `PicURL` split, `C:`/`P:` names); maps with `mapEbayWorkbook` (`:137`) given a native column table instead of the module constants (`:55-67`); reuses `planEbayGroups` (`:354`), `groupTargets` (`:413`), `resolveGroups` (`:433`), `checkEbayLedger` (`:332`) |
| Shopify reader | new `pim/catalog-shopify-csv.ts` | table + `mapShopifyCsv` + `checkShopifyLedger`; targets from `ChannelListing` (as `shopify/channel-sheet.service.ts:141-146`) |
| Column data | `channel-mapping/defaults.ts:91-118` | add `EBAY_BULK_COLUMNS` and `SHOPIFY_CSV_COLUMNS` (data only, old and new spellings) |
| Condition, policies, sites | `services/ebay-condition.ts:15-32`, `pim/reference-values.service.ts:34-42`, `ebay-trading-api.service.ts:12-18` | reused, no change |
| Form kinds | `packages/shared/channel-mapping.ts:10` (channels), `:14` (kinds) | add `SHOPIFY`; add `EBAY_BULK_TEMPLATE` and `SHOPIFY_PRODUCT_CSV` |
| Database | `schema.prisma:17673-17675` — `channel` and `formKind` are **`String`**, not enums; the migration checks only status, state and direction (`migrations/20260926m_channel_mapping_sets/migration.sql:108-112`) | **no migration**; only the schema comments change |
| Form identity | `channel-mapping/form.ts:31-43` (`ebayFormOf`), `:45-46` (`formLabel` knows Amazon and eBay only) | `ebayBulkFormOf`: formKey = the categories joined by `+`, or `PRICE_QUANTITY` for "All active listings"; `templateVersion` = `Version`; layout keeps the `#INFO` rows. `shopifyFormOf`: marketplace `GLOBAL`, formKey = the store account (its metafield columns are its own) |
| Draft rows | `channel-mapping/ebay-draft.ts:57` (pattern), `:27`, `:40` (reused) | `ebay-bulk-draft.ts`, `shopify-draft.ts`. `baseFor` (`store.ts:67-73`) also carries your aspect decisions from the same category's `EBAY_WORKBOOK` version |
| Import mapping | `channel-mapping/ebay-import.ts:13-31` (pattern), `store.ts:219` (`recordUse`) | two hosts; every import records its version |
| Export | `channel-mapping/ebay-export.ts:40`, `ebay-export-host.ts:12-68` (pattern); `lib/csv.ts:34` (`csvDocument`) | `ebay-bulk-export(-host).ts`, `shopify-export(-host).ts`; UTF-8, the sample's delimiter and line endings |
| Routes | `routes/channel-mapping-sets.routes.ts:91-109` (export), `:34-50` (targets: Amazon/eBay only), `:79-85` (Amazon template upload) | two export branches (`text/csv`); a Shopify branch for targets (`loadShopifyProductSpec`, `channel-specs/shopify.ts:144`); the upload also takes an eBay category template |
| Import routes | `routes/catalog-transfer.routes.ts:175-188` (preview), `:220-227` (apply) | unchanged: preview first, apply with the review token |
| Push | `channel-mapping/push.ts:73` | unchanged: pushes follow only Amazon template and eBay workbook versions |
| Sheet import format | `pim/sheet-transfer/sheet-import.service.ts:120`, `packages/shared/catalog-transfer.ts:139` | eBay bulk → `ebay`; add `shopify` |
| Web: product sheet | `products/[id]/edit/_studio/transfer/importModel.ts:5` (accepts `.csv`), `:10` (labels) | label "Shopify file"; nothing else (the file is detected) |
| Web: catalog page | `products/catalog-transfer/page.tsx:99` (File type), `:101` (Amazon account), `reviewText.ts:66` (market from file) | a Shopify store picker when the file is a Shopify CSV; an eBay bulk file states its own market |
| Web: File mappings | `channels/mapping/files/model.ts:19`, `:22-26`, `:329-333`; `FileMappingsView.tsx:67`; `ExportDrawer.tsx:24`; `TemplateUpload.tsx` | Shopify label and form words; "Upload template" for Amazon or an eBay category template; the export drawer asks for the store (Shopify) |
| Old cockpit export | `routes/ebay-cockpit.routes.ts:718-830` | removed once the new eBay export is live (it writes stock) |

All screens use `apps/web/src/design-system` components that exist today (Listbox, FileDropzone, Drawer, Banner).
No new control is needed (inferred).

---

## 4. Tests and proof

### 4.1 The approach (as CHMAP §8.6 and M5)

For each sample file, on a DB copy whose name contains `test`:
1. **Nothing unaccounted.** Every filled cell is imported, excluded with a reason, or refused (the CFI ledger; the eBay
   check is `checkEbayLedger`, a Shopify twin is new).
2. **Round trip.** File → import → export with the same version → the same cells. Allowed differences are named in the
   version (quantity, media and market columns left out; `#INFO` copied).
3. **Version pin.** Each golden file names the version it expects; a rule change shows which cells move.
4. **Upload-safety checks on every export:** each listing's `C:` set is complete; no `Quantity` column; no blank cell in
   a written Shopify column; option columns present whenever SKU is; Status present.
5. **Planted faults must be caught:** a blanked cell, a dropped `C:` column, a changed option value, a wrong Item number.

**Limit:** eBay offers no download of complete listings in its template (§1.1). So the full-template round trip is
Nexus → file → Nexus (export, then import, gives equal values). eBay's side is proved by one real Revise upload with
your word, read back with `GetItem` (already used, `routes/ebay-flat-file.routes.ts:3069`). "All active listings" and
Shopify's export are the channels' own files, so they get a true round trip.

**Fixtures:** anonymised copies go in `channel-mapping/__fixtures__/golden/` (CHMAP D2 A), made by the existing tools
(`scripts/chmap-anonymise.mts`, `chmap-golden-build.mts`) taught to read CSV. They replace item numbers, SKUs, policy
names, the store's handles and domain, image hosts, postal codes and prices. The pinned list in
`golden.vitest.test.ts:23` grows. Real files stay on your Mac.

### 4.2 Files needed from you, and the clicks

**eBay Italy** (Seller Hub is "Console venditori"; steps from E10):
1. **Category template, 177104:** Console venditori → **Rapporti** → **Caricamenti** → **Scarica un modello** → Tipo:
   **Crea nuove inserzioni** → choose category **177104** (Giacche e giubbotti) → file type **.csv** → download. Please
   also download it once as **.xlsx**, so I can see what differs. (The category chooser's wording is NOT VERIFIED.)
2. **All active listings:** in the same **Scarica un modello** list, the **edit price and quantity** template (Italian
   label NOT VERIFIED). It then appears under **Download** as **"All active listings"** (E1). Download the CSV.
3. **Optional:** one of your own filled upload files, if you have ever uploaded one.

**Shopify:** admin → **Products** → **Export** → **All products** → **Plain CSV file** → **Export products**. If a
product has more than 100 variants, the file comes by email (S3). Please also export once as **CSV for Excel, Numbers
…**, so I can measure the difference.
- **Which to pick: Plain CSV.** Shopify documents no technical difference (S3). The plain file is meant for text
  editors, and Nexus reads it as text. Opening either in Excel and saving again can change the encoding, the separator,
  12-digit numbers and leading zeros.

Put the files in a private folder, never in the repository (it is public).

---

## 5. Steps, risks, decisions

### 5.1 Rules this plan keeps

- **Stock is never imported from a file**, and never written into one (the stock ledger owns it).
- **Prices go through the one price door**, record-only on import (`writeChannelPrices`, `recordOnly`).
- **An import is a preview first.** A production import needs your word, per run: read → preview → write → read back →
  a restore path (`docs/channel-file-import/SESSION-PROMPT-2026-09-24.md:72-73`).
- **An export is a partial update** where the format allows: columns left out, never written blank.
- **Every import and export records its mapping version** (`ChannelMappingUse`).
- **Round-trip tests on real files**; anonymised copies committed, real files private.
- Every step: a DB copy named `test`, `tsc` for API, web and `packages/shared`, a positive control, a claim row in
  `docs/pes-claims.md` before the first edit.

### 5.2 Steps

| # | Step | Done when |
|---|---|---|
| N0 | **Measure the samples** (§4.2): literal headers, `#INFO` text, delimiter, decimal mark, BOM, line endings, `Version`, Shopify's two export types. | Every "NOT VERIFIED" in §6 items 1–9 is measured or still named. No code. |
| N1 | **Contract.** Form kinds, `SHOPIFY` channel, the two column tables, form identity and labels. | `tsc` 0 on all three; the 9 golden files unchanged; no migration (checked again). |
| N2 | **Sniffer and routing.** `sniffCsv`, worker and catalog-page branches. | The samples, the 9 goldens and one Nexus CSV are each named right; a Nexus CSV reads exactly as before; an Amazon template still never reaches ExcelJS. |
| N3 | **eBay import.** Reader, parent by row order, conditions, policies, pictures, decimal comma. | Ledger 0 unaccounted on both eBay samples; every quantity cell excluded; a planted change caught; the version recorded. |
| N4 | **eBay export (Revise).** Complete `C:` sets, policy names, header from the stored template. | §4.1 checks 2, 4, 5 pass offline. |
| N5 | **eBay golden files** (anonymised) in CI. | Pinned; planted faults caught. |
| N6 | **Shopify import.** Reader, old and new headers, store choice, link proposals. | Ledger 0 on the sample; inventory, status and media excluded; a planted change caught. |
| N7 | **Shopify export.** Always-columns, no-blank rule, option guard. | §4.1 checks 2, 4, 5 pass on the sample. |
| N8 | **Shopify golden files** in CI. | As N5. |
| N9 | **Screens.** File mappings (forms, upload, export), catalog page store picker, sheet import label. | Real browser: light, dark, 390 px, keyboard, a planted refusal shown word for word. |
| N10 | **First real runs, each with your word:** one eBay listing revised by upload, one Shopify product overwritten. | Read back equal; restore path written down; delayed re-read clean. |
| N11 | **Clean-up.** Remove the old cockpit CSV export. | A search finds no second eBay CSV writer. |

Order: eBay first (it reuses most of the eBay workbook engine), then Shopify. N0 comes first because the literal
headers are not on any official page.

### 5.3 Decisions for you

**D1 — New listings in an exported file.**
- **A (recommended): export changes existing listings only** (eBay Revise with an Item number; Shopify products Nexus
  already links). New listings are still created by Nexus's publish, which owns stock and the identity links.
- **B: also write new listings** (eBay `Add`, Shopify new handles). eBay needs a quantity above zero on every variation
  (E2), so the file would carry stock for the first time, and the new ids must be linked back afterwards.

**D2 — Shopify's compare-at price** (the struck-through "was" price).
- **A (recommended): add it to the one price door**, record-only on import like the price, and export it from there.
- **B: leave it out** of import and export; the column is omitted, so Shopify keeps its own value.

**D3 — Where the export buttons live.**
- **A (recommended): the File mappings page first** (it already exports Amazon and eBay by version and shows the gaps).
  The product sheet's Import accepts the new files automatically; its Export stays the Nexus file for now.
- **B: also add "eBay file" and "Shopify file" to the product sheet's Export dialog** in the same build.

### 5.4 Risks

- **eBay drops specifics, shipping or payment fields left out of a Revise** (E5). Guarded by the complete-set rule and
  by writing no shipping or payment columns.
- **Shopify erases on blank and deletes variants on missing options** (S1). Guarded by §2.4 and check 4.
- **A missing Status column may make a draft product active** (S1 says a file without Status uploads as `active`;
  whether that applies when overwriting is NOT VERIFIED). The export always writes Status.
- **Policy names need a live eBay account read** at preview (`reference-values.service.ts:34-38`). If eBay does not
  answer, the policy cells are refused, never guessed.
- **Size:** Nexus accepts files up to 10 MB (`catalog-transfer-file.ts:15`); eBay allows about 15 MB, Shopify 15 MB.
  A large Shopify export may be refused by Nexus until it is split.
- **Excel re-saves** change the separator, the encoding, 12-digit item numbers and leading zeros. The reader refuses a
  malformed Item number (`catalog-ebay-workbook.ts:166`) and says "use the file as downloaded".
- **Header drift:** eBay's display names and Shopify's renames. Old and new names are aliases in one version; a new
  header makes a draft version, as CHMAP §8.3 does.
- **Other lanes' files:** CFI owns `catalog-*-workbook.ts` and the sniffer; PSIE owns `sheet-transfer/**` and the product
  sheet dialogs; the attributes lane owns the channel specs. Claim rows first.
- **The public repository:** no real item number, policy name, store handle or domain in any committed file.

---

## 6. Not verified (the sample files settle most of these)

1. eBay: the literal header names today (`CustomLabel` or "Custom label (SKU)"; leading `*` on `Action`).
2. eBay: the exact `#INFO` rows and the `Version` an ebay.it template carries (1197 is not on any eBay page).
3. eBay Italy: comma or semicolon delimiter; decimal comma.
4. eBay: BOM allowed or not; blank cell on Revise = unchanged.
5. eBay: separator inside a multi-value `C:` cell; the Italian "does not apply" wording.
6. eBay: picture limit 12 or 24; the Best Offer column names.
7. Shopify: the canonical barcode header (`Barcode`, `Barcodes`, `Variant Barcodes`).
8. Shopify: any difference between the two export types; whether enum values are case-insensitive; whether
   "unlisted" is a valid Status.
9. Shopify: whether a missing Status column changes an existing product; whether import writes market prices.
10. Category 177104: leaf status and full path.
11. Current eBay file limits on an official page (only a forum reply by eBay's tools team gives 14.9 MB and 150,000
    lines).
