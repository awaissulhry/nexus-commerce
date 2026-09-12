# Product editor import and export — 2026-09-07

Implemented locally in both Shared product and Amazon/eBay sheets. The editor now uses the catalog workbook, validator, review and durable job engine. Channel import no longer leaves the editor; shared import no longer uses a separate CSV mutation path.

## Workflow

1. Open Import or Export on the product sheet. Default selection is the product in the editor URL, even when the sheet displays its entire variant group.
2. Explicitly choose parent and variants, selected sheet rows, or specific SKUs when needed. The variant group is the actual parent/child relationship, not the broader attribute family such as Jackets.
3. Shared scope includes shared facts and the editor's content language. Channel scope includes existing listings in the current channel, account, market and listing alias. The drawer waits for destination resolution before enabling these actions. All existing destinations and additional shared languages are explicit choices.
4. Download the editing XLSX, with identity/version columns, stored values and inheritance, instructions, dictionary, valid values and formula guidance. The displayed table remains a separately labelled reference CSV.
5. Upload the Nexus workbook or canonical attribute CSV. Blank value plus blank action preserves data. SET, CLEAR and INHERIT remain explicit. Exported INHERIT must be changed to SET when supplying a value.
6. Review complete, paginated before/after outcomes and save in Nexus. The selected boundary is shown on the review. Existing seller-channel publication workflows remain separate.
7. The editor reloads saved data and formulas, and emits product/listing invalidations for readiness. Reviews remain accessible after drawer dismissal and browser reload in the same session. A save continues on the server after dismissal. Retry requires another review.

Shared edits can change values inherited by variants and listings outside the file. This is stated in setup, workbook instructions and review. Record-change counts describe direct record changes. Imports do not rewrite standing mapping rules.

## Server boundary

- New `/api/catalog-transfer/products/:productId/options`, `/export` and `/preview` endpoints use view, export and import permissions respectively. Preview is always update-only.
- The server resolves selected product IDs to immutable SKU/parent identities and listing IDs to exact SKU/channel/account/market/alias identities. Client filenames and workbook metadata cannot broaden these identities.
- Every parsed action is checked, including unchanged exported values. Other products, shared languages or destinations are refused. Malformed channel-language inputs become blocking parser issues.
- The resolved boundary is persisted on the job and included in the input fingerprint. Apply checks it again; every serializable write transaction checks it again. Recovery and retries retain it, including update-only mode.
- Removed/replaced listing IDs and changed SKU/parent identities require a fresh review. Existing record versions, dependency snapshots, current field contracts and transactional checkpoints remain in force.
- Parent SKU is reference-only in editor exports. Changed parent relationships are refused during preview; use the product relationship tools.
- Limits: 500 selected products, 5,000 listings in the group, 50,000 attribute outcomes and 10 MB per import. Larger export workbooks use the existing bounded ZIP splitting; each extracted workbook is reviewed separately. Larger product groups use Catalog import & export.

## Verification

- **122 API tests passed** across scope isolation, registered HTTP routes, workbook round trips, canonical planner/jobs, export limits, transactions and permission ordering. One optional browser-fixture server test was skipped.
- **123 web tests passed** across editor scope selection, workbook destination choices, reference export and legacy diff utilities.
- API, Web and Factory type checks passed. Web and Factory token checks passed.
- Isolated HTTP tests downloaded a real wide channel workbook, edited its value/action cells, uploaded it, reviewed and applied it. Only the selected child listing changed; all other products and listings were compared and remained equal.
- Other tests cover unchanged shared-child and multilingual/multimarket round trips, other-SKU/account/market/channel/alias refusals, unowned jobs, replaced listings, concurrent edits, frozen scope on retry/recovery, and parent-change refusal.
- Live editor checks: Gale defaults to one SKU; explicit variant selection gives 21 SKUs and 105 listings. Shared and exact Amazon Germany editing downloads completed. Amazon Germany defaults to one SKU and one listing for the selected account, with no shared writes selected.
- Drawer presentation checked at 390 × 844 in light and dark themes: document and drawer scroll widths both 390px. Escape restored focus to the opening toolbar action.
- Browser testing found a shared Drawer focus-wrap bug with buttons inside collapsed disclosures. Fixed it in Web and Factory, added a catalog example, and documented it in both changelogs and DS-GAPS. Verified Shift+Tab from Close reaches the visible summary; after expanding, it reaches the revealed button; Tab wraps back to Close.

Logs: `/tmp/nexus-product-transfer-final-api-tests.log`, `/tmp/nexus-product-transfer-final-web-tests.log`, `/tmp/nexus-product-transfer-{api,web,factory}-types.log`, `/tmp/nexus-product-transfer-tokens.log`, `/tmp/nexus-product-transfer-factory-tokens.log`.

## Scope of this verification

No working-catalog products were imported or published. Apply tests used an isolated Prisma-shaped store through the real HTTP routes and job services. Browser checks used the existing product editor for reads, scope selection and downloads; browser upload/apply was not exercised against the working catalog. No deployment or live channel acceptance is claimed. Missing product facts and provider validation remain visible readiness work; an import save is not proof of publication readiness.
