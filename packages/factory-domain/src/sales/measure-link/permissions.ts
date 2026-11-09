import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Measurements by link (apps/factory-api modules/sales/measure-link; B-W2b-171; SAL-096, SAL-286; design links.measure and
 * its office connection sales.mtm › Measurements "lands as a new revision for review"), in the sales area. Checked with
 * can() against the profile's company (the link's) and party. Office only: the rider answers through the MEASUREMENTS link
 * (links.open, links.submit), never through a role.
 *
 *   sales.measurements.view    the revisions a rider sent by link: who sent it (the link's address and contact), when, the
 *                              notice shown, the values and the fit notes, and the front, side and back photos — each photo
 *                              opened is recorded (who looked, when). Body data and photos are personal data, so this is a
 *                              write risk on purpose: the read-only role does not hold it.
 *   sales.measurements.manage  send a rider a link to send measurements for a measurement profile or a made-to-measure order
 *                              line (photos required or optional), and set or move the day the body photos are deleted (the
 *                              rider asked; by default 90 days after the garment ships).
 */
export const SALES_MEASUREMENTS_DEFINITIONS = definePermissions('sales', {
  'measurements.view': {
    risk: 'write',
    description:
      'See the measurements riders sent by link: who sent them and when, the privacy notice shown, the values and fit notes, and open the front, side and back photos (body data: each photo opened is recorded).',
  },
  'measurements.manage': {
    risk: 'write',
    description: 'Send a rider a link to send measurements (and body photos) for a measurement profile or a made-to-measure order line, and set the day the body photos are deleted.',
  },
})

export const SALES_MEASUREMENTS_VIEW = 'sales.measurements.view' satisfies Permission
export const SALES_MEASUREMENTS_MANAGE = 'sales.measurements.manage' satisfies Permission
export const SALES_MEASUREMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_MEASUREMENTS_VIEW, SALES_MEASUREMENTS_MANAGE])

/**
 * The office templates (../../auth/roles/templates): sales sends the links and reads what comes back; the administrator too;
 * the production manager reads them (the pattern department works from them). The owner holds every permission.
 */
export const MEASURE_LINK_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [SALES_MEASUREMENTS_VIEW, SALES_MEASUREMENTS_MANAGE],
  sales: [SALES_MEASUREMENTS_VIEW, SALES_MEASUREMENTS_MANAGE],
  production_manager: [SALES_MEASUREMENTS_VIEW],
})
