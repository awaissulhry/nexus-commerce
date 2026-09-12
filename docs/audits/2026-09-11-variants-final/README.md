# VP.F audit — final verification pending

The missing selection column is restored before P/C on both Variants states. Shared identity, completeness, resolved channel values, editor metadata and write routes now come from the Information sheet's services and DS controls. Column customisation, family actions, import and row selection use the existing sheet mechanisms.

Owner follow-up, 2026-09-12: restored **eBay → Variation order**, the third channel task after Listing information and Description themes. This supersedes the earlier navigation-removal decision. The existing alias-scoped editor supplies axis/value ordering, inheritance controls and publication review. Signed-in verification covered navigation, direct URLs, keyboard reordering, discard and inheritance-reset preview; zero console errors and zero data writes. Web TypeScript exits0; Studio Vitest102 files/1561 tests pass. [Restoration evidence](variation-order-restoration.json), [navigation screenshot](variation-order-navigation.png), [page screenshot](variation-order-restored.png). The gate table below remains the historical full-pass measurement.

At 1440×900, all five approved captures measure 56/49/40/40/40px for top bar/subheader/scope/page/toolbar, 30px group strip, 28px headers, 36px rows and 36px footer. Both states have 43px selection and 380px identity columns; 21/21 visual rows match. The 420px mapping track has no vertical overflow. At 1280px all three toolbar configurations remain 40px high with no clipped buttons. All final signed-in captures have zero console errors.

Evidence:

- [Before and after measurements in the ledger](../../pes-claims.md) — VP.F section.
- [After tables](after-tables.md), [79-group functionality matrix](functionality-matrix.md), [gate receipts](final-gates.json).
- `before-*.json/png` and `after-*.json/png` — geometry, control inventories, copy and screenshots.
- [API parity](sheet-parity.json), [visual row parity](visual-row-parity.json), [responsive measurements](responsive.json), [DS mirrors](ds-mirrors.json).
- [Current local database read-back](rehearsal-readback.json), with separate named receipts for every rehearsal.

| Finished-tree check | Bare exit | Measurement |
|---|---:|---|
| Web / API / Factory TypeScript |0 /0 /0| No type errors |
| Studio Vitest |0|102 files,1559 passed |
| API Vitest |0|631 files,7725 passed,11 skipped |
| AG Grid import boundary |0|5787 TS,107 CSS scanned |
| Raw primitive ratchet |0|4340; no increase |
| Dark alias scope |0| No violations |
| Required-column witness tests |0|3 passed, including missing/duplicate/empty negative controls |
| Information/Variants parity |0|5 exact coordinates,21 rows each |
| Control census |2| Authentication required;0/12 surfaces measured |
| Editor-open gate |2| Authentication required |
| Layout-v2 gate |2|4 contract coordinates pass; browser authentication required |

The three standalone browser gates launch fresh browser contexts. They need an existing test storage-state file through `STUDIO_STORAGE_STATE`, or a normal local test login configured through `STUDIO_TEST_EMAIL` and `STUDIO_TEST_PASSWORD`. The current signed-in interactive browser is not a storage-state export. These gates must run serially after authentication is supplied. No full completion claim is made before all 12 census surfaces and the editor/layout checks finish.

The layout gate's obsolete seven-key expectation was replaced by the coordinate's actual required set, compared between columns and sheet contracts. Missing metadata cannot fall back to a smaller denominator; required fit is asserted at 1440px and above. Historical below-bar residuals are used only when their key set still matches. The control census now guards both the restored selection column and stacked chip labels.

Local rehearsal cleanup is confirmed: GALE Product58, shared axes Colore/Taglia restored, parent listing18, original 20 children retained. Five disposable DRAFT children are recoverably unlinked. Their only fixture listing is excluded, sync-paused, unpublished and has no external ID. The two real XXS rows remain version 1 with their suspect XS bags; the exact proposed correction is recorded in VP.F ledger row 15 and was not applied. Listing split remains held with its reason, as instructed.

Light text contrast measured 15.48:1 primary, 5.91:1 muted and 9.87:1 chip text; dark 12.73:1 primary/chips and 7.38:1 muted. These measurements are not a blanket WCAG AAA certification.

HEAD remains `80f6cfb84afa3a18f62bf9adccd16c1d27d17ebb`. Nothing was committed or pushed. This work adds shared mechanisms and regression checks; it does not promise that future changes can never introduce a defect.
