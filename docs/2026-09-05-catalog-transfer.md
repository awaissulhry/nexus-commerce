# Catalog import/export and toolbar follow-up — 2026-09-05

Implemented locally. This is a working catalog workflow, with a shared file contract, API, persisted previews/jobs and a Products → Import & export page. It is not a certification of complete marketplace coverage; the remaining acceptance work in [the attribute foundation](2026-09-05-product-attribute-foundation.md) still applies.

## What to review

1. Open `/products/next`, then choose **Import & export** in the page header to reach `/products/catalog-transfer`. The transfer page's breadcrumb and Back to products link both return to `/products/next`. The grid's separate **Export table** action downloads the filtered table as CSV.
2. Select Jackets and Italy, then download a family template. The Dictionary explains the available fields. Enter a SKU on each populated attribute row; fill an action explicitly.
3. In Export, choose **Edit and re-import**, enter `GALE-JACKET`, and download the file. Shared data appears in Products; category assignments in Listings; actual channel overrides and inheritance actions in Overrides.
4. Upload an unchanged editing export in **Update existing products** mode and preview it. It should report unchanged values and no refusals. Apply is disabled when there are no changes.
5. For a deliberate change, inspect the preview's SKU, account, marketplace, alias, field, before/after value and action before applying. A new product needs a shared name and family, or a parent with a family. Newly created products and listings are drafts.

No business-product changes were applied during verification.

## File contract

CSV and XLSX use the same version-1 columns:

`entity, sku, channel, accountId, marketplace, aliasKey, locale, field, action, format, value, version`

The format uses one attribute per row, allowing different families and channel categories without an enormous sparse table. XLSX separates Products, Listings and Overrides into sheets. CSV supplies `entity` on each row.

| Entity | Identity | Purpose |
| --- | --- | --- |
| Products | SKU, plus locale for localized content | Shared facts, family, parent and internal categories |
| Listings | SKU + channel + account ID + marketplace + alias key | Channel category and draft listing creation |
| Overrides | The same exact listing identity | Explicit channel values or return to inheritance |

`SET` writes the value. `CLEAR` explicitly empties supported fields. `INHERIT` removes the override. An empty action and value leave data unchanged. CLEAR and INHERIT require an empty value cell. Fields whose storage cannot distinguish a deliberate empty value from parent inheritance refuse unsupported operations.

Use `text` for text and identifiers; `json` for numbers, booleans, lists and records. Identifiers retain leading zeros, and false/zero remain values. Formulas, ambiguous identities, duplicate field actions, unknown fields, invalid shapes and stale versions are refused. A blank alias key means the primary listing; existing named aliases must belong to the specified product/account.

An **effective listing** export resolves shared values, mappings and overrides for the selected account. It is for review and cannot be imported as an editing workbook.

## Apply and limits

Previews persist in BulkOperation, belong to their creator and expire after 24 hours. Apply checks the current schema and stored snapshot again. Each product or listing mutation, audit entry and job checkpoint commits in one transaction. Expired worker leases can resume after interruption. Partial jobs retain their errors for download; operators can prepare a corrected file for another preview.

Import limits: 10 MB per file, 50,000 attribute rows and 5,000 imported product identities. Large catalog exports now split automatically into workbooks of at most 500 products, 50,000 attribute rows and 10 MB, downloaded together as a ZIP. There is no 500-product limit on the complete export selection. Full product records are fetched in pages of 100. The outer ZIP streams to the response; completed workbook buffers are retained while the download is prepared. Background export jobs and a dedicated retry-file download are not implemented. Price and stock changes remain in their dedicated workflows. Import does not queue marketplace publication.

Validation shares sheet contracts, applicability, shape coercion and channel validators. The draft transaction writer is separate from the manual bulk writer; complete validator/writer convergence is still follow-up work. Fresh eBay requirements remain blocked by the local credential-decryption failure documented in the foundation report.

## Verification

- 52 focused API tests passed: file semantics, preview validation, ownership, transaction concurrency and mapping resolution.
- 29 focused web tests passed for sheet layout and view chips. API TypeScript check passed. The final full web check reports three errors outside this change: two comparator-signature errors in `design-system/grid/workspace/columns.ts` and an unused `ReactNode` import in `WorkspaceGrid.tsx`.
- A live GALE-JACKET editing export containing shared data plus Amazon/eBay Italy listings re-imported into preview with **335 unchanged values, zero changes and zero refusals**.
- Its `GALE-JACKET-BLACK-MEN-3XL` variation also round-tripped with **324 unchanged values, zero changes and zero refusals**, preserving parent and channel inheritance.
- `apps/api/scripts/verify-catalog-transfer.mts` passed real database checks for draft creation, family assignment, locale isolation, exact-account listing creation, title override, return to inheritance, audit entries and stale-preview refusal. The transaction rolled back; persisted test products: **0**.
- Browser review covered templates, export controls, job ownership refusal, and light/dark presentation. Browser file selection and a user-owned apply remain operator acceptance checks; file parsing/preview and transaction writes were verified separately.

## Toolbar clipping

The shared SheetToolbar now wraps its controls when space is insufficient, preserves card padding and moves Customise/Export/Import/More together. Search uses its allocated width. Saved view labels may wrap without forcing the toolbar outside the card. No fixed toolbar height can conceal a second row.

Browser measurements passed for **Master, Amazon Italy and eBay Italy** at viewport widths **320, 375, 640, 768, 1024, 1280, 1440, 1728 and 2048**. All measured toolbar controls stayed within the card and viewport; no horizontal toolbar overflow occurred. Amazon retains one compact row at 1728 pixels. More opened successfully.

`scripts/check-control-census.mjs`, already invoked by the pre-push hook, now checks those widths for clipped controls and horizontal overflow. It permits wrapped toolbar height. The full census CLI was not rerun in this session; its syntax check and the corresponding live browser measurements passed.


## Products Next and large export follow-up

The supported catalog entry point is now `/products/next` → **Import & export**. The legacy Products navigation change was reverted. The new page's former Import link no longer goes to the legacy upload screen. Its separate table CSV download is labeled **Export table**. Both return links in catalog transfer lead to `/products/next`; browser navigation was verified in both directions.

Automatic workbook splitting keeps all of a product's rows together wherever possible, and never splits one product or listing target across imports. Oversized workbooks split further by encoded file size. ZIP downloads include numbered workbooks, instructions and a manifest of SKUs and row counts. Small exports remain a single XLSX. The browser chooses the correct `.zip` extension from the response content type.

The full live Jackets export now returns HTTP 200 with all **219 products / 62,731 attribute rows**: 49,941 rows in workbook 001 and 12,790 in workbook 002. The ZIP is approximately 2.5 MB. No rows were truncated.

Large-file verification also exposed repeated worksheet scans in the importer: ExcelJS computes `columnCount` by visiting every row, and the importer was invoking that getter inside every cell iteration. The reader now computes it once per worksheet. Attribute grouping in the planner also appends to existing groups without repeatedly copying them.

The focused suite now passes **65 API tests**, including a real 50,001-row XLSX/ZIP round trip, exports spanning more than 500 products, exact record preservation, file-size splitting and pagination completeness. API TypeScript checking passes. The previously documented three unrelated shared-grid web type errors remain.


Saved previews now retain the import rows at each target without duplicating the entire input again at job level. Preview creation asks the database to return only its ID and status, avoiding a second transfer of the large saved JSON payload. Existing saved previews remain readable.

Exact-text round-trip checks also caught XML carriage-return normalization in 21 Amazon descriptions. Text containing carriage returns or XML control characters now uses the existing JSON value format in XLSX, preserving the stored text and preventing false changes on an unchanged import.

Final live verification of the regenerated ZIP: workbook 001 previewed in 25.8 seconds with **49,941 unchanged rows**, and workbook 002 in 7.1 seconds with **12,790 unchanged rows**. Both returned HTTP 201, **zero proposed changes and zero refusals**. All **62,731 attribute rows** are accounted for. No product changes were applied.


## Nexus design system alignment — 2026-09-06

The page now uses the canonical Nexus design system for all controls, headers, cards, tabs, feedback, metrics and the preview table/pagination. The old UI-kit imports, native controls and local control/color styling have been removed. Page CSS contains layout and domain-content rules using semantic `--nds-*` tokens.

Collapsible supporting sections use the new shared `Disclosure`, with examples in the design-system catalog. `DataGrid` and `ProgressBar` gained optional accessible labels. Shared additions are mirrored in factory. `AGENTS.md` records the standing reuse rule, and the historical UI-kit reference now points to the canonical system.

Verification for the design-system migration:

- Web TypeScript check passes; 26 focused tests pass. Review tests preserve zero, false, empty text, explicit clearing, inheritance, exact listing scope and escaped file content.
- Web token guard and DS CSS parse checks pass. The page has zero raw controls/disclosures (previously 17) and zero raw color literals (previously 40); all nine page CSS token references resolve.
- Import and export controls fit 320, 375, 768 and 1280 pixel viewports without document overflow or clipped controls. Browser checks cover keyboard tabs, native disclosure Enter/Space, searchable family selection, account/category validation, export purpose and light/dark rendering. No page runtime errors were observed. The viewport and theme were restored after testing.
- Disclosure catalog examples were checked closed/open, with a focus ring, 13px text and 8px summary padding. The web/factory Disclosure, DataGrid and ProgressBar source files match. Local DS declarations were regenerated.
- Repository-wide guards still report pre-existing grid-lab native controls/type styles, PreferencesModal/preferencesLogic fork drift, and factory token-alias violations. The migration adds no exemptions or baseline increases.
- No catalog changes were applied. Review value rendering is covered by focused tests; this UI migration does not repeat the earlier database import/apply verification.
- Full web production build passes, including `/products/catalog-transfer`. The first sandboxed build stalled; the isolated build completed successfully with build access enabled (`NEXT_DIST_DIR=.next-catalog-ds-audit`).
