import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The bundles' permission (apps/factory-api modules/production/bundles; features MES-065, MES-066, MES-068, MES-073,
 * MES-184; A2 SCR-095 floor bundles, SCR-072 the work order's bundles), in the production area. Checked with can()
 * against the work order's company and site; a floor device works at its own site only (can() pins it, row-level
 * security too). The office reads a work order's bundles with workorders.view (they are part of the work order record).
 * Nothing here carries money.
 */
export const PRODUCTION_BUNDLES_DEFINITIONS = definePermissions('production', {
  bundles: {
    risk: 'write',
    description:
      "Make bundles from a work order's cut garments at the cutting table and print their tickets, reprint a lost or damaged ticket (a new code; the old one is refused when scanned) and void a bundle made by mistake before any scan names it (a floor device: at its own site).",
  },
})

export const PRODUCTION_BUNDLES = 'production.bundles' satisfies Permission

export const PRODUCTION_BUNDLES_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BUNDLES])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): bundles and their tickets at its own site. */
export const PRODUCTION_BUNDLES_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BUNDLES])
