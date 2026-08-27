/**
 * AG.1 — AG Grid module registration. The ONLY place modules are registered.
 *
 * WHY A CURATED LIST, NOT `AllEnterpriseModule`
 * `AllEnterpriseModule` pulls every feature — integrated charts drag in the whole AG Charts
 * runtime — into the first route that renders a grid. This app has 330 routes and a shared
 * client bundle; the grid is meant to be the cheapest thing on a workspace page, not the most
 * expensive. Every module below is one we can name a caller for, or a Phase-7 feature the spike
 * is explicitly proving. Add to this list deliberately, never with a wildcard.
 *
 * DELIBERATELY ABSENT (add when a real caller arrives, with the caller named in the commit):
 *   IntegratedChartsModule  — needs the ag-charts runtime; ~large. Phase 7.
 *   PivotModule             — no pivoting surface exists today.
 *   ServerSideRowModelModule— Phase 7. Exactly ONE consumer uses the current `server` prop
 *                             (marketing/ads/reporting/ReportRunner.tsx), so SSRM has no second
 *                             caller yet and would only add weight.
 *
 * Registration is idempotent and module-scoped, so importing this file from several entry points
 * is safe — but it must be imported before the first grid mounts, which is why the engine
 * component imports it at module scope rather than in an effect.
 */
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community'
import {
  CellSelectionModule,
  ClipboardModule,
  ColumnsToolPanelModule,
  ContextMenuModule,
  ExcelExportModule,
  FiltersToolPanelModule,
  LicenseManager,
  MasterDetailModule,
  MultiFilterModule,
  RichSelectModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  SetFilterModule,
  SideBarModule,
  StatusBarModule,
  TreeDataModule,
} from 'ag-grid-enterprise'

let registered = false

export function registerGridModules(): void {
  if (registered) return
  registered = true

  ModuleRegistry.registerModules([
    // Community: client-side row model, sorting, editing, keyboard nav, CSV export.
    AllCommunityModule,

    // --- Enterprise, one line per thing the hand-rolled stack does today ---
    // FilterPopover.tsx (675 L) — range/select/multiselect popovers.
    SetFilterModule,
    MultiFilterModule,
    // grid-lens ColumnPicker.tsx + the two forked Customize dialogs.
    ColumnsToolPanelModule,
    FiltersToolPanelModule,
    SideBarModule,
    // WorkspaceGridProps.hierarchy — depthOf/expandableOf/onToggle.
    TreeDataModule,
    MasterDetailModule,
    // WorkspaceGridProps.groupBy.
    RowGroupingModule,
    RowGroupingPanelModule,
    // WorkspaceGridProps.editMode — bulk inline edit + the compact in-cell
    // editors DS-GAPS records as missing (4 separate sightings).
    RichSelectModule,
    CellSelectionModule,
    ClipboardModule,
    // `exportable`/`onExport` — replaces hand-rolled exceljs at the grid layer.
    ExcelExportModule,
    // Footer count + selection count (GridFooter.tsx).
    StatusBarModule,
    ContextMenuModule,
  ])

  /**
   * The repo currently ships `patches/ag-grid-enterprise+36.1.0.patch`, which replaces the body
   * of `validateLicense()` with `return;`. Owner decision 2026-08-27: internal
   * development/prototyping only, licensing revisited before production.
   *
   * This call is here anyway so that switching to a real key is an ENV change and not a code
   * change — set NEXT_PUBLIC_AG_GRID_LICENSE_KEY, drop the patch, and nothing here moves.
   * Reading a missing env var is harmless; `setLicenseKey` is only called when one is present.
   */
  const key = process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY
  if (key) LicenseManager.setLicenseKey(key)
}
