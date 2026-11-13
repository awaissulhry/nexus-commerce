import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The made-to-measure office (apps/factory-api modules/sales/mtm; B-W2b-358; SAL-291, SAL-292, SAL-300, SAL-303; design sales.mtm),
 * in the sales area beside the measurements by link (sales.measurements.view | manage, B-W2b-171). Checked with can() against the
 * profile's customer (a profile has no company) and, for a worksheet, the company whose papers it is. Office only. Reading a
 * rider's profiles, revisions, reviews and worksheets is sales.measurements.view (body data: a write risk, the read-only role does
 * not hold it); a template is the size library's (product.styles.view | manage); a made-to-measure quote line is quotes.manage
 * plus sales.measurements.view over the profile's customer.
 *
 *   sales.mtm.record   record a rider's measurements as a new revision (who of ours measured and where, the privacy notice
 *                      given), and keep a version of the made-to-measure worksheet and order form (PDF)
 *   sales.mtm.review   the factory review of a revision: confirm the measures, or ask the rider or dealer for more (mailed);
 *                      nobody confirms measures they took themselves
 */
export const SALES_MTM_DEFINITIONS = definePermissions('sales', {
  'mtm.record': {
    risk: 'write',
    description: "Record a rider's measurements as a new revision (who measured, where, the privacy notice given) and keep a version of the made-to-measure worksheet and order form.",
  },
  'mtm.review': {
    risk: 'write',
    description: "The factory review of a rider's measurements: confirm them before a made-to-measure order goes on, or ask the rider or dealer for more (mailed). Nobody confirms measures they took themselves.",
  },
})

export const SALES_MTM_RECORD = 'sales.mtm.record' satisfies Permission
export const SALES_MTM_REVIEW = 'sales.mtm.review' satisfies Permission
export const SALES_MTM_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_MTM_RECORD, SALES_MTM_REVIEW])

/**
 * Who holds them (auth/roles/templates; the owner from every(), the read-only role none: both are writes): sales measures riders
 * in the showroom, at a track or a dealer and prints the worksheet; the production manager (the pattern department) reviews; the
 * administrator does both, as it sends the measurement links.
 */
export const SALES_MTM_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [SALES_MTM_RECORD, SALES_MTM_REVIEW],
  sales: [SALES_MTM_RECORD],
  production_manager: [SALES_MTM_REVIEW],
})
