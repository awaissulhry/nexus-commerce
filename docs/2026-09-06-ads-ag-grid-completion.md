# Advertising AG Grid completion — 2026-09-06

The local migration is complete for `apps/web/src/app/marketing/ads/**`. The advertising console consumes the Nexus AG Grid adapters, including Portfolios, Campaigns, Amazon and eBay workspaces, rules, reporting, bulk operations, and supporting drawers and wizards. No commit or push was made.

This continues [the migration design](2026-09-05-ads-console-on-ag-grid-design.md). Product management, catalog transfer, the legacy `/marketing/advertising` and `/marketing/ads-console` trees, and the Factory grid engine are outside this work's scope. Existing unrelated local changes were preserved.

## Implementation

- Completed the remaining DataGrid import migration in 40 advertising files. The current JSX census contains 47 `DataGrid`, 58 `AdsDataGrid`, and 7 `RulesGrid` usages across 99 files, with zero native tables. These are render sites and include wrappers, not distinct screen counts.
- Both advertising contracts now use the shared Nexus engine: `design-system/grid/workspace` and `design-system/grid/datagrid`. Feature callbacks, data access, controls, and saved preference keys remain with their existing consumers.
- Converted advertising table selectors to the adapters' published row and cell classes. The retired WorkspaceGrid table stylesheet and implementation now live only in the comparison lab.
- Fixed initial pagination and controlled selection synchronization, selection containing off-page IDs, keyboard navigation on later pages, saved sort initialization, accessible grid labels, and expanded row height measurement.
- Preserved native keyboard handling inside rendered form controls so Tab commits an inline edit once and leaves the input. Added an isolated, non-writing comparison fixture for this behavior.
- Added semantic advertising grid tokens and the reusable `TooltipPortalProvider` / `Tooltip portal` option to Nexus. Shared primitive, style, export, and token changes are mirrored to Factory. The web catalog, DS changelog, both READMEs, and DS gap log document the additions.
- Both advertising adapters opt into the shared tooltip portal. Portfolios' first-row Set budget, Rename, and Archive tooltips render in the Nexus tooltip layer above the header, with viewport clamping, hover/focus support, accessible descriptions, and Escape dismissal.
- Extended the module guard for automatic column sizing and row heights, lowered the retired-grid baseline, and made the import boundary include local untracked files and reject advertising regressions to table grids.

## Verification

| Check | Result |
|---|---|
| Full web tests | 232 files, 3,319 tests passed |
| Focused grid and advertising tests | 85 files, 1,214 tests passed |
| Web TypeScript | Passed |
| Production web build | Passed, isolated `.next-catalog-ds-audit` output |
| Web and Factory token freshness | Passed |
| Web generated DS declarations | All 218 current |
| Grid modules and detector self-tests | Passed |
| Retired-grid usage baseline and grid option identity | Passed |
| Web DS conformance, token guard, raw primitives, P3, CSS hex, help cursor, button vocabulary, silent-disabled guards | Passed |
| Whitespace check on changed advertising, adapters, primitives and guard files | Passed |

Browser checks used the local application and the isolated Nexus comparison lab:

- Campaigns: AG WorkspaceGrid, 100 displayed data rows, pagination available, no native table.
- Portfolios: AG DataGrid, 12 portfolios, nine headers, no native table.
- Bulk Operations / History: AG DataGrid, 23 rows, no native table.
- Apply Rules: AG WorkspaceGrid, 100 data rows plus totals, no native table.
- Control Room / Guardrails: AG DataGrid, 82 rows and 328 rendered inputs, no native table. No guardrail values were edited.
- eBay Ad Manager: AG WorkspaceGrid, 13 campaigns plus totals, no native table.
- Comparison fixtures: ascending and descending sort match the frozen reference; controlled selection preserves an off-page ID without callback echoes; page-two keyboard navigation targets the same campaign; saved column visibility survives reload; inline input focus survives updates and Tab commits once; edit mode can discard a draft; expanded rows measure 64px in both implementations.
- Portfolios Actions: the first tooltip overlaps the header vertically but is painted above it (`z-index: 1700`), outside the grid's clipping container. Mouse and keyboard checks covered the action labels and Escape. At 1024px, keyboard focus scrolls the actions into view and the tooltip stays inside the viewport without document overflow. Light and dark application presentation were inspected; the advertising console retains its established light surface.

The lab supports direct `?tab=workspace&scenario=...` and `?tab=datagrid&scenario=...` links, avoiding the cost of mounting every comparison at once. These checks establish representative behavior and geometry; they are not a claim of exhaustive pixel equality across every advertising route. Live campaign and budget writes were not used for verification.

## Existing failures outside advertising

The repository-wide AG import boundary reports seven pre-existing files outside the advertising console, now visible because untracked files are scanned:

- `apps/web/sheetWriter.ts`
- `apps/web/src/app/products/[id]/edit/_studio/ancillary/AnalyticsAdsTab.tsx`
- `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/persistence.ts`
- `apps/web/src/app/products/[id]/edit/_studio/sheet/master/columns.tsx`
- `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetExport.ts`
- `apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetColumns.ts`
- `apps/web/src/app/products/next/productsLayout.ts`

The DS fork guard also reports existing differences in `patterns/PreferencesModal.tsx` and `patterns/preferencesLogic.ts`. These unrelated files were left for their owning work. There are no advertising boundary offenders and no new shared-file drift from the tooltip or token additions.
