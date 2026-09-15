# GALE eBay Italy audit

**Identity audit complete. The unchanged workbook is not yet safe to import into the production product sheet.** The five live listing identities and all 100 variation memberships reconcile, but the catalog has two wrong shared sizes, four unmigrated listing shells, and source/schema differences. Local importer support is implemented and tested. No production product/listing data or source-workbook values were changed, and nothing was published to eBay.

## Verified directly with eBay

Readback: 15 September 2026, 06:55:41–06:55:47 UTC. All five `GetItem` calls succeeded using the xaviaracing seller account. Each response returned the requested Item ID, expected item-level seller SKU, matching title, Italy site, category 177104, and Active status. This verifies the five listings in the supplied workbook; it is not a search for every GALE listing on the account.

| Workbook parent / listing | Rows | eBay item ID | Live status | Variants |
|---|---:|---|---|---:|
| GALE-JACKET | 2–22 | [257584954808](https://www.ebay.it/itm/257584954808) | Active | 20 |
| IT-GALE-JACKET | 23–43 | [256564203510](https://www.ebay.it/itm/256564203510) | Active | 20 |
| GALE-JACKET-ALT1 | 44–64 | [256566101420](https://www.ebay.it/itm/256566101420) | Active | 20 |
| GALE-JACKET-ALT2 | 65–85 | [256566102729](https://www.ebay.it/itm/256566102729) | Active | 20 |
| GALE-JACKET-ALT3 | 86–106 | [256566103703](https://www.ebay.it/itm/256566103703) | Active | 20 |

There are **one physical product family and four alternate listings**, represented by five parent rows plus 100 child rows. The same 20 variant SKUs occur once under each parent. There are 25 distinct source SKU strings because the four historical aliases have their own parent labels. The canonical product model needs only GALE-JACKET and its 20 variants, with five listing identities for each.

Checks passed: no duplicate SKU within a listing, missing variant, extra live variant, mismatched Item ID, wrong source parent link, size/color discrepancy between the workbook and eBay, or incorrect membership-to-product ID. All 100 Nexus shared memberships point to the correct canonical variants. The primary membership cache uses Size/Color labels; the alternates use Taglia/Colore. Their values reconcile after translating these two known axis names.

The source has one sheet (`ebay_it`), 105 data rows, 79 columns, 65 populated columns, and 5,902 populated cells. No formula or Excel error cells were found. The duplicate Quantity/Qty columns agree on every child row. All 18 distinct source image URLs returned HTTP 200 with an image content type. That checks availability, not visual correctness of the photographs.

## Corrections required in Nexus

### Two shared XXS records are wrong

Both `GALE-JACKET-BLACK-MEN-XXS` and `GALE-JACKET-YELLOW-MEN-XXS` have shared `variantAttributes.Size = XS`. They also contain the malformed literal `variantAttributes: "[object Object]"`; the category variation bag contains the same malformed entry. The workbook, all five live eBay listings, and the membership values correctly identify these SKUs as XXS.

Correct these two shared size records through the product relationship/variation writer and remove the malformed nested key, preserving the existing product IDs, colors, true XS siblings and all marketplace links. The generic listing import intentionally does not rewrite shared product facts.

### Four listing shells have not become product-sheet aliases

IT-GALE-JACKET and ALT1–ALT3 are active `EBAY_LISTING_SHELL` Product records. There are **zero ProductListingAlias records** for this family. The primary has 21 eBay ChannelListing rows; the alternates have only four shell-level ChannelListing rows plus 80 SharedListingMembership rows. The product-sheet importer cannot address these 80 alternate variant memberships as normal alias listings yet.

Production still has both pre-alias unique indexes: `ChannelListing_productId_channelMarket_conn_key` and `ChannelListing_productId_channel_marketplace_conn_key`. The application correctly refuses alias creation while these exist.

The existing `pes5-adopt-shells.mts` script is insufficient for this import: its write section does not set aliasKey or alias account ownership and does not materialize the 80 variant listing rows. It was not executed.

## Workbook versus live listing data

All five titles and all 100 variant size/color pairs agree. Prices differ in **58 of 100 variation rows**. The source price is €105 for every variant. Current distributions are:

| Listing | Live prices |
|---|---|
| GALE-JACKET | 20 variants at €105.00 |
| IT-GALE-JACKET | 18 variants at €109.99, 2 variants at €105.00 |
| GALE-JACKET-ALT1 | 13 variants at €109.00, 7 variants at €105.00 |
| GALE-JACKET-ALT2 | 13 variants at €109.00, 7 variants at €105.00 |
| GALE-JACKET-ALT3 | 14 variants at €109.00, 6 variants at €105.00 |

**25 quantity cells differ**, corresponding to the following five physical SKUs repeated across five listings. Available quantity was calculated from eBay Quantity minus QuantitySold, matching the application’s readback convention. Repeated listings share stock and must not be counted as separate inventory.

| SKU | Workbook available | Live available per listing |
|---|---:|---:|
| GALE-JACKET-BLACK-MEN-3XL | 12 | 13 |
| GALE-JACKET-BLACK-MEN-M | 6 | 9 |
| GALE-JACKET-BLACK-MEN-XL | 6 | 7 |
| GALE-JACKET-YELLOW-MEN-L | 28 | 29 |
| GALE-JACKET-YELLOW-MEN-XL | 28 | 27 |

Other differences and limits:

- **Item specifics:** the primary returns only Marca = Xavia. Its source row says Xavia Racing and supplies 18 additional non-variation specifics that are not returned live. Each alternate returns nine specifics, with several different source values (for example Materiale = Tessuto and Protezione = Gomiti/Schiena/Spalle). The JSON comparison records every populated parent aspect separately. Absence from GetItem is not an invented replacement value.
- **Handling time:** the workbook says 3 days; eBay returns 0 on all five listings. The three shipping/payment/return policy IDs agree exactly on all five parents. Treat this as a policy/content decision before publishing.
- **VAT:** source 22%; the requested live response did not return VATPercent. This was not interpreted as zero or independently verified as a current tax rate.
- **Descriptions and images:** only the primary group has populated source description/image cells. The 84 alternate-row blanks must preserve current content. Live descriptions include generated theme markup, so byte inequality is not a finding of wrong copy. Full text equivalence and photo content were not certified.
- **Condition and format:** NEW versus Trading API 1000, and FIXED_PRICE versus FixedPriceItem, are API vocabulary differences. GTC and location country IT agree.

## Import support and exact coverage

The product editor now recognizes this historical single-sheet eBay XLSX locally. It resolves existing destinations by marketplace, Item ID, source parent identity, SKU and optional immutable Listing ID, obtains account/alias/version from the scoped catalog, and refuses missing or ambiguous matches. Adopted alias source SKUs come from adoption provenance, never the editable alias label. Parent rows are normalized to the canonical product SKU while retaining their separate alias.

Blank cells preserve data. Lists are decoded using the current category’s cardinality; the scalar Materiale value `Poliestere, Nylon` remains one string. Weight becomes a value/unit pair. Zero and false remain typed values. Ordered image slots are preserved. Price, quantity, follow/buffer controls, remote IDs and sync history are explicit references. Unknown populated columns and lifecycle actions block the reviewed import. A category inconsistent with its parent also blocks.

The previously missing Location field now maps to the existing `platformAttributes.itemLocationCountry` field in the shared eBay schema. It means the country code, not the city name.

On the exact workbook with production identities, the local adapter reports **734 mapped attribute inputs, 396 explicit references, and 252 issues**: 84 rows lack true alias destinations, and the 21 resolvable primary rows each have eight source/schema issues. The entire import is blocked; the valid primary subset is not silently applied.

With hypothetical properly adopted alias identities, all **5,902 populated source cells** are accounted for: **3,502 mapped inputs + 1,560 explicit references + 840 issues**. Every column reconciles to its populated-cell count. These are input counts, not saved-change counts.

The 840 remaining issues are eight columns repeated across 105 rows:

| Source column | Source value | Required decision |
|---|---|---|
| Stagione (Season) | Tutte le stagioni | Provider schema currently requires the exact choice Tutte le stagione. Review this normalization; the importer does not silently change it. |
| Genere ⚠ | Uomo | Not in the current category schema; overlaps Adatto a. |
| Livello di protezione ⚠ | CE Livello 2 | Not in the current category schema; retain supporting product information and decide the intended destination. |
| Paese di fabbricazione ⚠ | Pakistan | Not in the current category schema; Paese di origine already contains Pakistan. |
| Tipo di giacca ⚠ | Da moto | No current category field with this identity. |
| athlete ⚠ | Unisex | No current category field; the value does not describe an athlete. |
| body type ⚠ | Regolare | No current category field; select an explicit destination if needed. |
| team name ⚠ | Giacca | No current category field; the value does not describe a team. |

An **in-memory cleanup rehearsal**, assuming the alias conversion and explicitly excluding the seven custom columns from the import while using the provider’s exact season choice, produces **3,607 mapped inputs across 105 listing identities, 1,560 references, and zero adapter issues**. This was a representability test only. It did not create aliases, save product data, run a full production preview, modify the source file, or certify publication readiness. Original custom values remain in the source and audit evidence.

## Concrete migration and import sequence

1. Back up the GALE family, its four shell products, all affected listings, memberships, translations and dependent references. Recheck all five remote IDs and the two XXS corrections against current values.
2. Prepare and test the database change removing the two obsolete unique indexes while retaining the account- and alias-aware unique indexes. This is a deployment prerequisite, not something a file upload should change.
3. Adopt exactly IT-GALE-JACKET and ALT1–ALT3 into four GALE-JACKET aliases under xaviaracing / eBay IT. Preserve each original parent ChannelListing ID and Item ID; set both aliasId and aliasKey and the account ID. Create the 80 variant ChannelListing rows using the verified membership-to-product mappings. Preserve the 100 memberships and their stock controls. Record adoptedFromProductId and soft-delete shells only after their references and content remain reachable. Rehearse rollback and all existing eBay stock/media readers before production adoption.
4. Correct the two shared XXS records using the existing transactional writer. Recheck the true XS siblings, all 20 product IDs and all five live item links.
5. Resolve the eight source/schema columns above and review whether historical content should replace today’s draft values. Keep price/quantity updates in their dedicated workflows. Resolve handling-time and live-specific differences separately before any publication.
6. Run the complete 105-row product import preview, then apply only the reviewed draft changes. Verify saved Italian content, independent aliases, unchanged shared inventory, and every mapped/reference/refused input. Publish to eBay only as a separate requested action.

## Validation and delivery status

- 106 automated tests passed across eight relevant suites; three optional browser/benchmark tests were skipped.
- Real registered HTTP routes were exercised against an isolated in-memory catalog: primary plus two aliases saved independently, source labels survived alias renaming, product records/remote IDs remained unchanged, and no outbound sync job was created.
- A missing alias made the entire reviewed import INVALID and apply returned 409, with no product-content or audit writes.
- A five-listing / 100-variant fixture round-tripped through the canonical Nexus workbook format with all 105 listing identities intact.
- API TypeScript checking and patch whitespace checking passed. This task changed no design-system component or control styling. There was no browser presentation or accessibility certification.
- Changes are local and uncommitted. They have not been deployed. Unrelated product-list, delete/cache and design-system/grid-layout edits appeared during the session and were preserved.

## Evidence

- [Full row, field and live reconciliation](reconciliation.json)
- [All 79 source columns and their import outcomes](column-coverage.json)
- [Current and hypothetical import probe summaries](import-summary.json)
- [Five eBay read receipts](live-receipt.json)
- [Image URL availability checks](image-links.json)
- [Automated checks](tests.log)

Original workbook SHA-256 (unchanged): `6a13bb2f74ea90b2c529d2f9d9787ff7887ed3999d2a35751d656188c9c5affc`. Raw catalog snapshots and authenticated GetItem response XML are retained locally in the audit working directory with restricted file permissions. The shared report contains no access tokens or credentials.

Method reference: [eBay GetItem documentation](https://developer.ebay.com/Devzone/XML/docs/Reference/eBay/GetItem.html). GetItem returns current listing details; IncludeItemSpecifics requests the aspect data used here.
