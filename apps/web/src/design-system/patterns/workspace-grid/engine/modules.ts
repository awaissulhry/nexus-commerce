/**
 * AG.1 / AG.4 — AG Grid module registration. The ONLY place modules are registered.
 *
 * WHY THE WILDCARD NOW, AFTER AG.1 ARGUED AGAINST IT
 * AG.1 registered a curated list of sixteen and warned off `AllEnterpriseModule` because it drags
 * every feature — including the AG Charts runtime — into the first route that renders a grid, on
 * an app with 330 routes and a shared client bundle. That reasoning was correct and it still is,
 * for a PRODUCTION surface.
 *
 * It does not apply here. Nothing in the app renders this engine: `AgWorkspaceGrid` has exactly
 * one importer, `/design/grid-lab`, and the Owner's direction (2026-08-28) is that no page moves
 * onto it and the whole build stays on that test page. So the weight lands on one design-system
 * route that a reader opens deliberately, and the curated list stops being a safeguard and starts
 * being a list of features the lab cannot show.
 *
 * `AllEnterpriseModule` is 85 public modules — row grouping, pivot, tree data, master/detail,
 * cell selection + fill handle, clipboard, Excel export, every filter incl. Advanced, both tool
 * panels, status bar, menus, sparklines, integrated charts, find, notes, batch edit, undo/redo,
 * grid state, calculated columns, and all four row models.
 *
 * 🔴 THE CONDITION ON THIS. The moment a production page mounts this engine, this line goes back
 * to a named list — the bundle argument above returns in full, and it is the reason AG.1 wrote it
 * down. Treat a wildcard reaching a shipped route as a regression, not as the status quo.
 *
 * Registration is idempotent and module-scoped, so importing this file from several entry points
 * is safe — but it must be imported before the first grid mounts, which is why the engine
 * component imports it at module scope rather than in an effect.
 */
import { ModuleRegistry } from 'ag-grid-community'
import { AllEnterpriseModule, LicenseManager, ValidationModule } from 'ag-grid-enterprise'
import { AgChartsCommunityModule } from 'ag-charts-community'

/**
 * Sparklines and integrated charts are the two features that are NOT self-contained: both refuse
 * to initialise without an AG Charts runtime, and `AllEnterpriseModule` alone does not carry one.
 * Without this the grid renders and only those two fail — with a readable message, but only
 * because ValidationModule is registered below; otherwise it is a silent blank cell.
 *
 * `ag-charts-community` rather than the enterprise charts build: it covers line/bar/area
 * sparklines and the standard chart types, and nothing here has asked for the enterprise-only
 * chart set yet.
 */
const ENTERPRISE_WITH_CHARTS = AllEnterpriseModule.with(AgChartsCommunityModule)

let registered = false

export function registerGridModules(): void {
  if (registered) return
  registered = true

  // Everything. `AllEnterpriseModule` already contains the community set, so it is registered
  // alone rather than alongside `AllCommunityModule`.
  //
  // ValidationModule is NOT inside AllEnterpriseModule (checked: 305 reachable modules, none of
  // them it) and is added in development only. Without it AG reports problems as a bare number —
  // "warning #25" turned out to be a real defect in `getRowId` that had been firing on every
  // mount since AG.1 and was unreadable for exactly that reason. It is dev-only because its whole
  // job is printing message text, which is weight a built page should not carry.
  ModuleRegistry.registerModules(
    process.env.NODE_ENV === 'development'
      ? [ENTERPRISE_WITH_CHARTS, ValidationModule]
      : [ENTERPRISE_WITH_CHARTS],
  )

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
