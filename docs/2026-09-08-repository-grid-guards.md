# Repository grid guard cleanup — 2026-09-08

All changes remain uncommitted and unpushed. No product values were saved during browser verification.

## Findings and fixes

| Check | Finding | Resolution |
| --- | --- | --- |
| DS fork drift | Previously reported SourceIndicator export order mismatch | Already resolved in the current workspace; rechecked successfully |
| Factory token guard | Previously reported 54 platform aliases | Already resolved in the current workspace; rechecked successfully |
| CSS DS shadow | 32 selectors in `app/design/grid-lab/legacy/workspace-grid.css` | Narrowed 10 selectors to direct legacy inputs and removed 22 unused bulk/eBay checkbox and native-pager selectors |
| CSS radius | 24 unnamed radii in that same frozen grid-lab stylesheet | Used standard tokens plus two documented 4px/5px reference tokens, mirrored and generated in Factory |
| Grid option identity | Two inline callbacks in the formula catalog | Stable row identity and memoized save callback |
| AG import boundary | Seven direct grid type imports outside the engine | Imported through the public DS grid barrel; added the missing CellClassParams export |
| Retiring grid kit | 41 legacy DataGrid consumers against a ceiling of 32 | Migrated all 10 consumers newly introduced by the uncommitted work to the existing AG adapter; 31 remain |

These are repository/pre-push guard failures, not Git corruption or merge conflicts. The unresolved findings were grid-related. Two formula review dialogs were among the new legacy consumers, so the additional findings were not all unrelated to the formula work.

The migrated consumers cover formulas, mapping, listing presets, eBay presentation rules and catalog-transfer review/history. They keep their existing row/column contracts. The adapter's previously ignored `keyboardScroll` option now enables AG cell navigation: in the product formula preview, ArrowRight moves focus from Product to Before. Embedded controls retain their own keyboard handling. A 320px formula-results specimen is included in the catalog.

The legacy comparison keeps its existing control geometry and corner shapes. Its 4px/5px tokens are explicitly scoped to the frozen reference; the current control radius scale is unchanged. No guard thresholds, baselines or exclusions were relaxed.

## Verification

- Focused Web suites: 20 suites / 231 tests passed.
- Full Web suite: 260 suites / 3,520 tests passed. The initial sandbox run could not bind the local HTTP fixture; the permitted rerun passed all tests.
- Web and Factory typechecks passed. Both generated-token checks, token guards, fork drift, token resolution, CSS parse/shadow/hex/radius, dark alias scope, raw primitives, DS conformance, grid import/identity/kit/module checks, DS API exports, DS-GAPS append-only and whitespace checks passed.
- Browser: selection and search comparison grids preserved 70 measured controls after the selector change; legacy checkboxes remain 20px with 5px corners after token conversion. Space selects and clears rows; search filters rows.
- Product Studio: real formula preview rendered through the AG adapter in light and dark themes; arrow-key cell navigation verified. Previews were closed without applying.
- Listing presets: five built-in rows rendered and the read-only Shopify details drawer opened successfully.

This verification covers the listed guards and the affected UI. It is not a full production build or a run of every pre-push stage.

The new catalog result grid measured 320px client width and 320px scroll width in both light and dark themes, and ArrowRight moved focus from Brand to Current title. This is a narrow-container check, not a complete mobile-device audit.

Further theme, API-boundary and build verification is recorded in [the repository quality follow-up](2026-09-08-repository-quality-followup.md).
