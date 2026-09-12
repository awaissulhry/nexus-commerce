# Exported workbook formatting

The subsequent [functionality verification](../2026-09-08-workbook-functionality/README.md) adds explicit choice rules, compact data rows, protected references, visible expiry and native boolean compatibility. It records the current 16,379-choice limit and final checks; the details below describe the earlier formatting pass.

The product-editor and wide catalog workbook writer now presents fixed choices as **one row per attribute and destination**, followed by Value 1, Value 2 and subsequent columns. The destination stays visible because the same attribute may have different valid values in different marketplaces. Scalar dropdowns use named ranges that point to the corresponding horizontal row. JSON list fields explain their entry format instead of offering a misleading single-choice dropdown.

The formatting also adds readable attribute labels and filtered reference tables, links back to data sheets, frozen identifiers, consistent Arial typography, fitted row heights, high-contrast headers and written color guidance. Editable values use pale amber, identities/managed values use gray, and explicit action controls have amber headers. Working tabs precede reference material. Import metadata and advanced technical dictionary columns remain available but hidden. The dictionary reader accepts both original and new readable headers.

Product-editor exports no longer reserve 50 empty input rows, since their contract only permits updating exported records. Generic catalog templates retain their input area. Horizontal choice rows are limited by Excel’s available columns, with an explicit error above 16,380 choices rather than silently omitting values. Reference cells count toward the existing workbook size budget. Banded reference rows use bounded conditional formatting to avoid allocating a large rectangular matrix around sparse option lists.

## Verification

- **53 tests passed, 3 optional tests skipped** across workbook round trips, product transfers, scope construction, download splitting and HTTP transfer routes. [Log](tests.log).
- New tests verify independent choices for the same field in two destinations; range endpoints beyond column Z; leading zeros, commas, Unicode and formula-looking literal choices; typed/legacy JSON values; list-entry guidance; old dictionary compatibility; and explicit refusal above Excel’s column limit.
- **Native render:** LibreOffice 26.2 opened the final generated XLSX and rendered every sheet. Verified leading-zero GTINs, blank dictionary cells, primary/Summer/Outlet listing labels, readable wrapped content, horizontal choices and the formula example. The export used LibreOffice’s documented [single-page-per-sheet PDF option](https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html), including the hidden metadata sheet for inspection. The PDF is an inspection artifact, not a print-layout promise.
- Artifact Tool previews were also inspected. Its XLSX importer misrepresented some numeric-looking strings and empty-string shared cells in the initial preview. Saved-file round trips and LibreOffice confirmed the original values were intact. Native renders are the retained visual evidence.
- Text contrast ratios: main header 12.88:1; editable header 9.19:1; action header 7.13:1; editable cells 14.63:1; reference cells 13.90:1; reference links 8.78:1. This checks the chosen colors, not full accessibility conformance.
- **API type check:** no workbook-file diagnostics. Four unrelated TS2339 errors at `apps/api/src/lib/workspace-hook.ts:43` currently fail the full command. [Log](types.log). No web or shared design-system source was changed, so no Factory mirror or token regeneration was needed.
- Microsoft Excel UI interactions and the normal product-page integration were not repeated for this formatting change. No deployment or live product mutations were performed.

## Example and visual evidence

[Example workbook](example-editing-workbook.xlsx) contains synthetic product data and three listing aliases. It illustrates the real export writer’s formatting. Its synthetic baseline is not registered in the running application, so it is not intended for catalog import.

[Instructions](instructions.png), [Products](products.png), [Italian content](content-it.png), [Amazon aliases](amazon-italy.png), [Dictionary](dictionary.png), [Valid values](valid-values.png), [Formula examples](formula-examples.png), [hidden metadata](metadata.png).

Regenerate the example from the repository root:

```sh
node --import tsx docs/audits/2026-09-08-workbook-format/build-example.mts
npm run test --workspace=@nexus/api -- src/services/pim/catalog-workbook.vitest.test.ts src/services/pim/catalog-product-transfer.vitest.test.ts src/services/pim/catalog-workbook-scopes.vitest.test.ts src/services/pim/catalog-transfer-download.vitest.test.ts src/services/pim/catalog-transfer-http.vitest.test.ts
npm run typecheck --workspace=@nexus/api
```
