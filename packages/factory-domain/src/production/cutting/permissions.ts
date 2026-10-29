import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The cutting log's permissions (apps/factory-api modules/production/cutting; features MES-051, MES-056, MES-058,
 * SCM-194, SCM-253; A2 SCR-094 floor cutting, SCR-071 the work order's cutting), in the production area. Checked with
 * can() against the work order's company and site; a floor device cuts at its own site only (can() pins it, row-level
 * security too). The office reads a work order's cut log with workorders.view (it is part of the work order record).
 * Nothing here carries money.
 */
export const PRODUCTION_CUTTING_DEFINITIONS = definePermissions('production', {
  cut: {
    risk: 'write',
    description:
      "Cut hides for a work order at the cutting table: scan a hide (issued to the work order by the scan when it is still in stock), log the garment sets or parts cut from it, close it with its remnant back to stock or the rest as waste, and undo one's own last cut (a floor device: at its own site).",
  },
  'cut.correct': { risk: 'write', description: 'Correct a wrong cut log entry with the reason: a mirror entry that takes its pieces and area back.' },
})

export const PRODUCTION_CUT = 'production.cut' satisfies Permission
export const PRODUCTION_CUT_CORRECT = 'production.cut.correct' satisfies Permission

export const PRODUCTION_CUTTING_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_CUT, PRODUCTION_CUT_CORRECT])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): cutting at its own site. Never a correction: the office's. */
export const PRODUCTION_CUTTING_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_CUT])
