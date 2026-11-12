import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Suppliers in depth (B-W2b-311; SCM-002, SCM-004, SCM-008, SCM-012, SCM-016, SCM-289; apps/factory-api
 * modules/purchasing/suppliers-depth). Reading a supplier's profile, its closures and who receives what is parties.view;
 * its kinds, default lead time, origin and what each contact receives are kept with parties.manage (the supplier record is
 * the party record); its price list is imported with purchasing.sources.manage (approved sources). One permission of its
 * own, checked with can() over the supplier's company AND the supplier:
 *
 *   suppliers.status   set where a supplier stands with us — prospect, approved, approved with conditions, on hold,
 *                      blocked, inactive — with the reason (a supplier on hold, blocked or inactive gets no new purchase
 *                      order); also the Supplier status column of the parties import. A decision of its own, as parties.block
 *                      is: the buyer and quality decide it, finance does not.
 */
export const SUPPLIERS_DEPTH_DEFINITIONS = definePermissions('purchasing', {
  'suppliers.status': {
    risk: 'write',
    description: 'Set where a supplier stands with us (prospect, approved, approved with conditions, on hold, blocked, inactive) with the reason; on hold, blocked or inactive it gets no new purchase order.',
  },
})

export const PURCHASING_SUPPLIERS_STATUS = 'purchasing.suppliers.status' satisfies Permission

export const SUPPLIERS_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_SUPPLIERS_STATUS])

/** The role templates that hold it (the owner holds every office permission). */
export const SUPPLIERS_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  buyer: [PURCHASING_SUPPLIERS_STATUS],
  quality_inspector: [PURCHASING_SUPPLIERS_STATUS],
})
