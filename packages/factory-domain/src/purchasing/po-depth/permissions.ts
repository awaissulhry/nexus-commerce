import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Purchase orders in depth (B-W2b-296; apps/factory-api modules/purchasing/po-depth). The order's own depth — its delivery
 * schedule, its rate at order, where it is delivered, the supplier's dates and their history — is part of the order:
 * purchasing.view reads it, purchasing.manage changes a draft's schedule, rate and ship-to and records or moves the
 * supplier's dates (checked with can() over the order's company, site and supplier, as every order write).
 *
 *   tolerances.manage   keep the delivery tolerances (over and under the ordered quantity, per company, supplier and
 *                       material or kind; beyond them a receipt is refused or waits for a yes): add, change, archive. A
 *                       tolerance decides how much a receipt may bring, so it has its own permission: the buyer
 *                       (design purchasing.settings) and the owner through every(). Reading them is purchasing.view.
 */
export const PO_DEPTH_DEFINITIONS = definePermissions('purchasing', {
  'tolerances.manage': {
    risk: 'write',
    description: 'Keep the delivery tolerances: how far over or under the ordered quantity a receipt may be, per company, supplier and material, and whether more is refused or waits for a yes.',
  },
})

export const PURCHASING_TOLERANCES_MANAGE = 'purchasing.tolerances.manage' satisfies Permission

export const PO_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_TOLERANCES_MANAGE])

/** The office templates that keep the tolerances (one line per template; the owner from every()). */
export const PO_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  buyer: [PURCHASING_TOLERANCES_MANAGE],
})
