# Product studio export fixes

Verified against the local application and GALE-JACKET on 2026-09-11/12.

## Reproduced failures

- **Duplicate workbook value: GALE-JACKET / sku.** A channel dictionary contains a `sku` attribute. The workbook reserved that name for Nexus identity, removed it from the dictionary, then attempted to write its value over the identity. This stopped exports including Shopify. The writer now escapes colliding attribute headers (`value:sku`), keeps the original field key in the dictionary, and reverses the encoding during import. Product SKU, channel SKU, listing alias and record version remain separate. Other reserved names and prefix collisions are covered as well. Existing workbook headers remain supported.
- **Select the EBAY DE category before exporting its attributes.** One incomplete destination aborted the entire selected export. A missing cached category schema could cause the next failure. Export now permits the available field catalogue and records category/schema limitations in the workbook instructions. It retains every selected listing, without inventing categories or weakening import validation. Import still requires the relevant category definitions before accepting changes.

The server log contained repeated instances of both failures. Both were reproduced in the export drawer before changing the code. Catalog readiness badges represent separate product-data validation; these changes do not suppress them or fabricate missing product information.

## Verification

- Actual browser exports succeeded for the current Amazon listing, parent and variants, shared details, the displayed table CSV, all destinations, and displayed attributes.
- After the fix, both full and displayed-attribute workbooks contain **21 shared products, 21 Italian content records, and 127 listing records**: 84 Amazon listings across DE/ES/FR/IT, 42 eBay listings across DE/IT, and one Shopify listing.
- Reopened both downloaded XLSX files with ExcelJS. All nine data sheets have distinct headers and the expected record counts. The full file has a separate `value:sku` attribute in its Shopify sheet.
- Browser console capture returned no warnings or errors for the exercised exports. The export drawer reported “Download started.”
- **105 tests passed, 3 optional tests skipped** across workbook, workbook scopes, export, product transfer, HTTP transfer, and transfer planner suites. New regressions cover colliding headers in v2/v3 workbooks, exact identity/value restoration, channel SKU HTTP export, incomplete destinations, and strict import schema checks.
- API TypeScript check passed.

Logs: `/private/tmp/nexus-export-fixes-tests.log`, `/private/tmp/nexus-export-fixes-types.log`.

Changes are local. No deployment or catalog-field edits were performed. Normal export snapshots were created by the application during download verification. No platform UI or shared design-system files changed.
