import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The rework loop's permission (apps/factory-api modules/production/rework; feature MES-126; design production.scrap
 * "Scrap & rework", floor.operation "Rework"), in the production area. Checked with can() against the work order's
 * company and site; a floor device works at its own site only (can() pins it, row-level security too). Reading the
 * rework of the sites in the office is production.scrap.view (../scrap/permissions). Nothing here carries money, and no
 * figure is per person (Statuto dei Lavoratori art. 4: a rework names no worker).
 */
export const PRODUCTION_REWORK_DEFINITIONS = definePermissions('production', {
  rework: {
    risk: 'write',
    description:
      "Send garments back to an operation to be made again (from a scan's rework count, or by hand with the reason), split them off into a bundle of their own, start the rework and finish it with how many came out good and how many were scrapped, or cancel it with the reason (a floor device: at its own site).",
  },
})

export const PRODUCTION_REWORK = 'production.rework' satisfies Permission

export const PRODUCTION_REWORK_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_REWORK])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): rework at its own site (it is scanned on the floor). */
export const PRODUCTION_REWORK_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_REWORK])
