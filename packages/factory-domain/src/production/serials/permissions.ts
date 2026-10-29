import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The garment labels' permission at the final operation (apps/factory-api modules/production/serials; features MES-076,
 * PRD-348, QHS-051, PRD-331; A2 SCR-096 floor garment labels, SCR-072 the work order's labels), in the production area.
 * Checked with can() against the work order's company and site; a floor device works at its own site only (can() pins
 * it, row-level security too). The office reads a work order's serials and its label log with workorders.view (they are
 * part of the work order record). Nothing here carries money.
 */
export const PRODUCTION_SERIALS_DEFINITIONS = definePermissions('production', {
  serials: {
    risk: 'write',
    description:
      "Print the garment labels of a work order's finished garments at the final operation (the batch number on each, or a serial per garment for a serial-tracked style), only where a valid certificate covers the colourway and size that day; reprint a label with a reason (the same batch or serial); void a serial before its garment is released (a floor device: at its own site).",
  },
})

export const PRODUCTION_SERIALS = 'production.serials' satisfies Permission

export const PRODUCTION_SERIALS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SERIALS])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the garment labels at its own site. */
export const PRODUCTION_SERIALS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_SERIALS])
