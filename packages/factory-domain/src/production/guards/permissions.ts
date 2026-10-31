import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The checks before a scan counts (apps/factory-api modules/production/guards; B-W2b-46; MES-070, MES-097, MES-098,
 * MES-114; design floor.operation "Checks before it counts" and the pop-up "Team leader override"). The report itself is
 * production.scan; the office reads the checks the floor met and the traced lots with production.scan.correct (the team
 * leaders' and supervisors' right) and workorders.view (part of the work order record). Overriding a held check is the
 * team leader's, signed on the tablet with their own PIN: this right is held by the team leader's floor role, never
 * checked on the operator's session. Nothing here carries money; nothing is a figure per person.
 */
export const PRODUCTION_GUARDS_DEFINITIONS = definePermissions('production', {
  'scan.override': {
    risk: 'write',
    description:
      "Sign a team leader's override of a check that held a floor scan (more garments than the operation before passed, a skipped required operation, a bundle of another line) on the tablet, with one's own PIN and a reason; never on one's own scan.",
  },
})

export const PRODUCTION_SCAN_OVERRIDE = 'production.scan.override' satisfies Permission

export const PRODUCTION_GUARDS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCAN_OVERRIDE])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the team leader's override on the tablet. */
export const PRODUCTION_GUARDS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SCAN_OVERRIDE])
