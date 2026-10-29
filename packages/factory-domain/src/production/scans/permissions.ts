import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The operation scans' permissions (apps/factory-api modules/production/scans; features MES-069, MES-090, MES-095,
 * MES-096, MES-167, MES-308; A2 SCR-090 operation screen, SCR-072 the work order's bundles & progress, SCR-073 work in
 * progress, SCR-023 the refused scans), in the production area. Checked with can() against the work order's company and
 * site; a floor device scans at its own site only (can() pins it, row-level security too). The office reads a work
 * order's WIP and scans with workorders.view (they are part of the work order record). Nothing here carries money, and no
 * figure here is per person (Statuto dei Lavoratori art. 4).
 */
export const PRODUCTION_SCANS_DEFINITIONS = definePermissions('production', {
  scan: {
    risk: 'write',
    description:
      "Report a bundle done at an operation with its good, scrap and rework counts, undo one's own last report until the next action, and ask a correction of one's own older report (a floor device: at its own site, online or from its offline queue).",
  },
  'scan.correct': {
    risk: 'write',
    description:
      "Decide the floor's correction requests (approve: a CORRECTION row voids the old scan, which stays; or refuse, with a note), never one's own scan's; and see and clear the floor's refused scans.",
  },
})

export const PRODUCTION_SCAN = 'production.scan' satisfies Permission
export const PRODUCTION_SCAN_CORRECT = 'production.scan.correct' satisfies Permission

export const PRODUCTION_SCANS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCAN, PRODUCTION_SCAN_CORRECT])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): scanning at its own site. Never the decision on a correction. */
export const PRODUCTION_SCANS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCAN])
