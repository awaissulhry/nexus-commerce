# GALE · eBay Italy · completed import

**Production data import completed on 15 September 2026.** One physical product
family, 20 variants, one primary listing and all four requested aliases.

## Listing identities

| Listing | Role | eBay item ID | Variants |
|---|---|---|---:|
| GALE-JACKET | Primary | [257584954808](https://www.ebay.it/itm/257584954808) | 20 |
| IT-GALE-JACKET | Alias 1 | [256564203510](https://www.ebay.it/itm/256564203510) | 20 |
| GALE-JACKET-ALT1 | Alias 2 | [256566101420](https://www.ebay.it/itm/256566101420) | 20 |
| GALE-JACKET-ALT2 | Alias 3 | [256566102729](https://www.ebay.it/itm/256566102729) | 20 |
| GALE-JACKET-ALT3 | Alias 4 | [256566103703](https://www.ebay.it/itm/256566103703) | 20 |

Direct eBay GetItem calls at 08:06 UTC returned Success for all five active
listings owned by xaviaracing. All 100 child SKUs, parent associations, sizes,
colors, prices and available quantities reconcile. Parent listing IDs were kept;
80 alias child listing records were added. The four old shell products were
retired with their media, history and adoption provenance retained.

## Quality checks

- 105 of 105 imported listing records saved; zero failed or unprocessed records.
- All 5,902 populated workbook cells accounted for: 3,607 mapped values and
  2,295 explained reference, duplicate-image-slot, unit or obsolete-field exclusions.
- All 3,691 final values read back exactly, including the 84 additional Italian
  alias descriptions. Zero mismatches and zero variation collisions.
- Every listing group reaches 100% readiness with zero errors or warnings under
  the updated validator. Readiness concerns required catalog fields; it is not
  an eBay publication or a certification of manufacturer claims.
- Corrected two XXS master variants previously labeled XS.
- Kept all current stock controls and physical quantities. The source contains
  58 outdated price cells and 25 outdated quantity cells; these did not overwrite
  current values. Corrected 59 membership price references from eBay: 58 stale
  values and one missing price.
- Added the existing Italian GALE description to the 84 blank alias rows. Each
  alias keeps its own title, description theme, media gallery and item ID.
- Reviewed all 18 source images. Replaced the German chart with the existing
  1600px Italian eBay size chart in 20 primary variant image lists. Removed
  three 500px duplicates in favor of their existing 1600px originals.
- Normalized the season to eBay's exact category choice, `Tutte le stagione`.
  Seven obsolete custom columns remain in the unchanged original workbook and
  source audit; they are excluded from current category attributes.
- Reconciled all 105 legacy listing snapshots and 100 membership snapshots.
- Preserved all 84 other-channel listings, 159 product image records, shared
  translations, original eBay price/stock controls, and all outbound queue rows.

## Import support and validation

The product-sheet importer now recognizes the historical eBay workbook format,
uses exact item/parent/variant/account/alias identities, and refuses ambiguous or
invalid rows. Localized Style preview and Decimal price validation defects are
fixed. Workbook/product/source/HTTP suites passed 74 tests; additional alias and
relationship checks passed in an 83-test run. Final numeric resolver/storage
regressions passed 75 tests. API type checking passed.

**[Corrected template: GALE IT - VERIFIED.xlsx](GALE%20IT%20-%20VERIFIED.xlsx)**
passed a fresh import dry run: all 105 records and 3,691 values unchanged, zero
errors. It retains the source layout, uses the adopted listing IDs, includes the
reviewed content and images, and carries current eBay price/quantity references.

The original workbook is unchanged. Uploading the original unchanged again will still
flag its seven obsolete columns and non-exact season choice; those were explicit
reviewed corrections in this import, not silent generic importer rules.

**Application deployment:** pending final release verification. Database import
and all data corrections are already committed in production. The 100% readiness
check used the updated application code against that production data.

## Source versus live values

No eBay publication or revision was sent. The workbook's editable draft content
is not byte-identical to current live content: eBay descriptions contain their
theme markup, the primary listing uses Size/Color API axis labels where the
source uses Taglia/Colore, and handling is 3 days in the source versus 0 returned
by eBay. The three business-policy IDs match exactly. Source VAT is 22%; eBay did
not return VAT, so that value is source-derived. These differences are recorded
without claiming that the import made all live content identical.

## Evidence

- [Final verification](verification.json)
- [Corrected workbook dry run](verified-workbook-readback.json)
- [100 verified variant identities and live values](variant-identities.json)
- [Import receipt](import-receipt.json)
- [Quality correction receipt](quality-receipt.json)
- [Direct eBay read receipts](live-receipt.json)

Source SHA-256: `6a13bb2f74ea90b2c529d2f9d9787ff7887ed3999d2a35751d656188c9c5affc`.
