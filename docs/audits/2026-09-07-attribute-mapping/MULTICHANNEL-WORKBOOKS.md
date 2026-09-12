# Multi-channel and multilingual catalog workbooks

Verified on 7 September 2026. Implemented in the local workspace; not deployed in this session. No production product, translation, listing, price or stock values were changed, and nothing was published.

## Result and scope

The catalog transfer page can generate a single Nexus workbook containing shared product facts, independent language sheets, and listing sheets bound to an exact channel, account, marketplace and category. Editing exports default to all marketplaces. Each product or listing is one row per SKU, with values and explicit actions in separate attribute columns.

This covers the connected listing channels: one active Amazon account and two active eBay accounts. The other active connection is Amazon Ads, which is an advertising service rather than a listing destination. Additional listing channels still require their own validated adapter and field contracts.

The architecture retains the existing canonical transfer planner and reviewed, transactional apply workflow. The new workbook and Amazon native-file adapters produce the same attribute operations; they do not introduce a second persistence path. The feature UI composes existing Nexus design-system components. The usability follow-up also fixes shared Listbox focus recovery, mirrored in Factory.

## How to use it

1. Open Products → Import & export → Create workbook and choose a product family. Add each account, marketplace and category destination. Their content languages are included automatically; choose any additional languages by name.
2. For existing products, use Export data → Editing → All marketplaces to retain versions and exact override/inheritance state. The supplied Gale export is an example using the current catalog.
3. Read Instructions, Dictionary and Valid values before filling data. Keep machine headers, sheet names, scope coordinates, dictionary encodings and versions intact. AI may help author values, but should use verified facts and explicit translations only.
4. Shared facts belong in Products; translations belong in their Content locale sheet. Marketplace-specific copy and exceptions belong in the corresponding listing sheet. Adding a SKU to a listing template also assigns its declared category.
5. A value with no action means SET. Both blank preserve the existing value. Exported INHERIT cells must be changed to SET when filling an override. CLEAR and INHERIT require an empty value; removing a row or column does not delete stored values.
6. Recalculate spreadsheet formulas, verify the result, and paste values into data sheets. The Formula examples sheet may retain formulas. Formula/error cells in import sheets are refused rather than trusting cached results.
7. Upload as Nexus workbook, review the complete preview, and apply the intended changes. For an original Amazon template, select Amazon template and its account/marketplace instead.

One workbook is an input to Nexus. It is not a universal file that can be uploaded directly to Amazon or eBay. Their existing publication adapters remain responsible for channel submissions.

## Language and marketplace boundaries

- Shared product facts are reusable across destinations. Locale-specific content is keyed independently of marketplace.
- Each listing sheet preserves channel, account, marketplace, alias, category and record version. Values cannot silently move from Amazon Italy to Amazon Germany or between seller accounts.
- Listing content currently follows the platform's primary publication language for each marketplace. Separate regional product locales are supported, but multiple independently authored listing languages inside the same marketplace are not a new capability of this change.
- No translations or missing product facts were invented. Empty language sheets allow explicit authoring; blank values preserve existing translations.

## Supplied Amazon Italy file

Source: `GALE IT.xlsm`, in the user's Gale Amazon Italy listings directory. The original file was read without modification. It contains 21 SKUs, 344 machine-path columns and 70 populated columns. It has no VBA project or product-sheet formulas despite its `.xlsm` extension.

The existing Amazon template reader now recognizes the marked product sheet and all 24 metadata chunks, including 226 embedded value-alias dictionaries. The adapter matches machine attribute paths against current category fields. It preserves ordered lists, typed booleans, dimensions and units, converts documented Italian labels to provider values, and retains original worksheet row numbers in errors. Unknown populated columns, conflicting scopes, deletion commands, duplicate paths and formula/error cells are refused.

Read-only fields on existing listings and commercial fields are explicitly reported as exclusions. Channel copy is not silently promoted into shared product facts. Relationships from a native Amazon file do not overwrite existing shared relationships; creation can use an explicitly selected family and supplied parent reference.

Current review results:

| Result | Count |
| --- | ---: |
| SKUs | 21 |
| Canonical attribute operations | 935 |
| Proposed changes | 893 |
| Unchanged attribute operations | 42 |
| Reported exclusions | 225 |
| Planner issues | 0 |

The original workbook declares `COAT`; the current Gale Amazon listings mostly inherit `OUTERWEAR`. The proposed changes therefore need business review before apply. Zero planner issues does not certify complete live channel publishability.

`outputs/gale-multimarket-2026-09-07/Amazon-Italy-import-review.json` records the before/after changes and all exclusions. A review-only import job was also staged through the isolated local API against the actual database. It was not applied; its anonymous test ownership is intentionally not exposed as a signed-in browser job.

## Verified deliverable

`outputs/gale-multimarket-2026-09-07/Gale-all-marketplaces.xlsx` exports the current 21 Gale SKUs across Amazon DE, ES, FR and IT, and eBay IT. It includes shared data and Content en, it, de, es and fr sheets. Empty locale values represent authoring space/inheritance, not completed translations.

The export was reimported and planned against current records: **22,397 attribute operations, all unchanged, zero parser issues, zero planner issues and zero unexpected changes**. `verification.json` beside the workbook records the result and destination scopes.

An independent API template check generated Amazon IT/COAT, Amazon DE/COAT and eBay IT/177104 with four content languages. The file contains 867 dictionary entries and 10,320 valid-value rows. Filling sample SKUs and translated names produced six correctly scoped category operations and four localized names with zero parser issues; these synthetic values were never applied.

## Safeguards and tests

- Current canonical field contracts validate edited values; read-only existing values may round-trip unchanged. Older stored type mismatches use explicit Dictionary JSON encoding, preserving strings, lists, zero, false, identifiers and control characters exactly.
- Missing columns and blank cells preserve data. Duplicate writes across sheets, undeclared sheets, changed headers, incorrect category scopes and stale record versions are rejected.
- Existing bounded transfer downloads still split large exports. Workbooks are limited to 10 MiB, 50,000 attribute outcomes, 2,000 data columns per sheet and a two-million-cell scan/allocation budget. Template selection is limited to 30 locales and 30 destinations.
- **130 API tests passed**, with one optional browser-fixture server test skipped. **10 web tests passed**. API and web typechecks and the web token guard passed.
- HTTP tests cover preview, review-token apply and persistence of Italian/German translations plus different Amazon accounts and marketplaces; they also check stale versions and preservation of shared prices, stock and names.
- Browser checks covered destination/category selection, enabled template download, account-to-marketplace keyboard order, and a 390-pixel layout in light and dark themes without horizontal overflow.
- Every workbook sheet was rendered for visual inspection. Representative final product, translated-content and Amazon sheets were inspected again after improving title wrapping. Formula helpers recalculated from a 43-character example to a 37-character changed example and back.
- Rendering/recalculation used the artifact-tool runtime; the final workbook remains the production ExcelJS export. A runtime rendering import issue with empty shared strings was corrected only in the verification copy using independently read source values. The literal `#NAME?` option in the cached Amazon `team_name` valid-value list is source data, not a formula error. Native Excel recalculation has not been separately certified.

## Remaining live requirements

This work verifies the import/export and reviewed persistence path. It does not certify every product's facts or all live channel requirements. Pricing, inventory, safety/compliance claims, complete conditional category requirements, translated copy review and live publication acceptance retain their dedicated checks. Production deployment and live listing submission were not performed.

## Usability follow-up — 7 September 2026

The page now starts with a visible Create workbook tab. Import & review, Export existing products, and Sources & history are separate tasks. A successful editing download offers the next import step; a new-template download selects create-or-update mode, while an existing-product editing export selects update-only. The mode remains visible before review. Destination/language selections persist when switching tabs. Reference-market guidance and uncommon regional language codes are disclosed separately from normal setup.

Marketplace languages are automatically included in both the form and backend template generation, independently of client-supplied locales. Additional languages use readable checkbox labels. The server normalizes submitted language/channel/market codes, rejects malformed destinations and duplicate account/market/category coordinates, verifies account restrictions, and fails the whole template if any category schema is unavailable. Different categories and marketplaces remain distinct.

Amazon product type choices use readable names with their provider identifiers. Where available, reviewed category paths enrich cached choices. Selected eBay marketplaces also reuse the platform's taxonomy breadcrumb endpoint; lookup is limited to those markets, batched in groups of 200 IDs, and uses abort/stale-result protection. Names remain separate from exact provider IDs. Missing names expose a retry action and retain the ID. Browser verification confirmed searching “Giacche” selects category `177104` in eBay Italy.

The review uses readable account/marketplace/language names and status labels, explains exclusions with a direct filter action, and labels completion “Changes saved in Nexus.” It links to Products for listing checks and publication. No-op files show that no changes are needed. These labels do not imply live channel acceptance.

Newly generated workbooks include field and action guidance in header notes. The writer's legacy-value scan and reader's column lookup avoid repeated searches for each attribute. The reader additionally enforces its scope and outcome limits for sparse/category-only inputs. Existing file versions and explicit SET/CLEAR/INHERIT semantics remain compatible.

Browser testing exposed a shared Listbox defect: Escape closed a portalled picker with focus left on BODY. Selection and cancellation now return focus to the trigger; click-away retains focus at its clicked destination. Web and Factory have identical source changes, documented in their catalogs/changelogs and `.claude/DS-GAPS.md`. The verified sequence is account picker → Escape → account trigger → Tab → marketplace picker.

Follow-up checks: **136 API tests and 16 web tests passed**, with the same one optional browser-fixture server test skipped. API, Web and Factory typechecks passed; Web and Factory token guards passed. Browser checks covered automatic Italian/German selection, persisted setup across tabs, successful workbook download and import handoff, eBay names/search, and a 390-pixel layout in light/dark themes without document overflow. A generated three-destination API template parsed sample input with six correctly scoped categories and four translated names, zero issues, and no persistence of synthetic data.

The previously delivered Gale artifact and its 22,397-entry round-trip audit remain the initial data verification. This follow-up does not claim that every connected marketplace/category has a current schema, that every product fact is complete, or that any live listing was submitted.
