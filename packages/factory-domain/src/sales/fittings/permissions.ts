import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Fittings, alterations and remakes of made-to-measure units (apps/factory-api modules/sales/fittings; B-W2b-360; SAL-054,
 * SAL-297, SAL-353; design sales.mtm › Fittings "Book a fitting", "Record outcome"), in the sales area beside the made-to-measure
 * office (sales.mtm.record | review, B-W2b-358). Checked with can() against the appointment's or the fitting result's company and
 * customer. Office only. Reading appointments and fitting results is sales.measurements.view (the rider's appointments and the
 * changes asked to their measures are personal data, as the profile's: the read-only role does not hold it); the alteration a
 * fitting opens is also sales.repairs.manage (W2a's repair command); the remake order of a return is the return's decision
 * (sales.returns.decide) and orders.manage, as W2a's replacement order.
 *
 *   sales.fittings.manage   book, move, close and cancel fittings, showroom visits and measuring sessions (the invite and its
 *                           changes mailed to the rider with the .ics), record what a fitting found per point of measure, and
 *                           name the alteration and the new measurement revision it led to
 */
export const SALES_FITTINGS_DEFINITIONS = definePermissions('sales', {
  'fittings.manage': {
    risk: 'write',
    description:
      'Book, move, close and cancel fittings, showroom visits and measuring sessions (the invite mailed to the rider), record what a fitting found per point of measure, and open its alteration or name the new measurement revision it led to.',
  },
})

export const SALES_FITTINGS_MANAGE = 'sales.fittings.manage' satisfies Permission
export const SALES_FITTINGS_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_FITTINGS_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every(), the read-only role none: a write): sales books the fittings in the
 * showroom, at a track or a dealer and records them; the production manager (the pattern department) records what a fitting found;
 * the administrator as it does the rest of the made-to-measure office.
 */
export const SALES_FITTINGS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [SALES_FITTINGS_MANAGE],
  sales: [SALES_FITTINGS_MANAGE],
  production_manager: [SALES_FITTINGS_MANAGE],
})
