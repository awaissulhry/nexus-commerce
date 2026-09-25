# Predictions — written 2026-09-24 ~23:20, BEFORE any import run (from code reading only)

Database for every run: private copy `nexus_cfi_20260924` of the local Docker `nexus_development` (127.0.0.1:55439). Never production.
Paths exercised = the functions the routes call (catalog-transfer.routes.ts:135-136 catalog page; :45-75 product-sheet drawer; :100-104 source mapping).

## Product-sheet drawer (`/catalog-transfer/products/:id/inspect` → worker → readEditorPart)
- P1 any `.xlsm` → REFUSED "Use CSV or XLSX. Other spreadsheet formats are not supported." (worker :51 → readTransferFile :115). The dropzone does not even offer .xlsm (ProductTransferDrawer.tsx:203).
- P2 Amazon template saved as `.xlsx` (GALE IT.xlsx 16 Sep) → ExcelJS load in the worker; either the 90 s deadline ("took too long") or, if it loads, no `ebay_` sheet and no Nexus manifest → readTransferWorkbook refuses. 0 rows either way.
- P3 our eBay `ebay_it` workbook (GALE IT eBay) → resolveEbayWorkbook. Every row with a populated `Action` cell gets an ISSUE (catalog-ebay-workbook.ts:110) but its other cells still map. Only rows whose Item ID matches an existing listing of THIS product group resolve; rows of the 4 other listings (ALT shells) → issue "does not identify exactly one existing listing" unless their shells are adopted aliases. Price/Quantity → EXCLUDED (reference only). Images 1–6 → one `imageUrls` list.
- P4 root `XAVIA-eBay-IT-<FAMILY>.xlsx` (sheet named by family, not `ebay_xx`) → not recognised → readTransferWorkbook refuses → 0 rows.

## Catalog page (`/products/catalog-transfer`, File type "Amazon template") → readAmazonCatalogWorkbook
- P5 GALE IT/DE/FR/ES FINAL (.xlsm, v2, full "create or replace") → parses (jszip). Rows = productType + schema-matched attributes. EXCLUDED: price/quantity (managed), parentage_level + child_parent_sku_relationship, `::record_action`, amzn1.volt.ca.* identifiers. ISSUES: populated keys with no unambiguous schema field. mode=update touches only existing SKUs.
- P6 German PARTIAL "Bearbeiten (Teilaktualisierung)" → classifyRecordAction (template-workbook.ts:297) finds no marker ('teilweise' ≠ 'Teilaktualisierung'; 'aktualisieren' ≠ 'aktualisierung') → 'unknown' → EVERY row refused. IT/FR/ES partial → 'partial' → imported.
- P7 DELETE file ("Löschen") → every row refused ("Delete or unknown listing actions cannot run").
- P8 two-language file (en_GB + it_IT) → every column tagged with the second language → ISSUE "different marketplace or language".
- P9 OLD flat file (TemplateType=fptcustom, grammar 'legacy') → REFUSED whole file: "no reliable marketplace/language metadata" (catalog-amazon-workbook.ts:21).
- P10 AIREON IT (COAT + PANTS in one file) → both schemas loaded (both cached for IT) → both map.
- P11 Blank cell: ALWAYS "no change" (catalog-amazon-workbook.ts:42) — also for FULL "create or replace" rows, where Amazon itself would REMOVE the attribute. So after a full-replace upload Nexus can keep a value Amazon dropped.
- P12 A file formula (`<f>`) anywhere in the data sheet → whole file REFUSED (template-workbook.ts:488).
- P13 Catalog page, File type "Nexus workbook" with an eBay/Amazon native file → refused (not the Nexus layout).

## Source mapping (`/catalog-transfer/source/inspect`)
- P14 Amazon templates (10 sheets) → REFUSED "must have one data worksheet". Our eBay workbook (1 sheet, 79 columns) → ACCEPTED as a generic source (every column must then be mapped by hand).

## Round trip (written ~23:45 BEFORE the run) — GALE IT FINAL: preview → apply (clone) → native export (flat-file vault export) → compare every cell
- R1 Keys the import EXCLUDES (price, fulfillment code, parentage, parent SKU, record action, product_id_type, size_system, brand, condition) come back from Nexus's OWN store, not from the file — they match only where Nexus already held the same value.
- R2 The 46 imported fields mostly come back equal (≥ 90 %); differences expected in list fields (bullet_point / special_feature / generic_keyword slot counts) and in localized value labels (the file holds display labels, the export writes what Nexus stores).
- R3 `::record_action` comes back BLANK by design (template-vault.service.ts:242) — a known difference on every row.
- R4 Export BEFORE the import already differs a lot (local Nexus lacks ~870 of these values); AFTER must differ less. The difference between the two = what the import really stored where the export reads.
