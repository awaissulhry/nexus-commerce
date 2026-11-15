import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Likely duplicates (apps/factory-api platform/imports/duplicates; B-W2b-427, PLT-178; design admin.import "possible
 * duplicates", customers.new and materials.new "Duplicate warning"). Seeing likely duplicates needs only the record's
 * own view permission (parties.view, product.materials.view): the warning on create and in an import's check, and the
 * list of possible duplicates. Merging two records is rare and costly (a second customer splits its orders and its
 * credit, a wrong merge archives the wrong one), so it is a permission of its own, on top of the record's manage
 * permission over BOTH records:
 *
 *   duplicates.merge   merge a duplicate customer, supplier or material into the record that stays: its free contacts,
 *                      addresses, tax identity or colours move, it is archived, both keep an audit row with the reason
 */
export const IMPORTS_DUPLICATES_DEFINITIONS = definePermissions('imports', {
  'duplicates.merge': {
    risk: 'write',
    description: 'Merge a duplicate customer, supplier or material into the record that stays (with that record type\'s manage permission over both): its free contacts, addresses, tax identity or colours move to it and the duplicate is archived.',
  },
})

export const IMPORTS_DUPLICATES_MERGE = 'imports.duplicates.merge' satisfies Permission

export const IMPORTS_DUPLICATES_PERMISSIONS: readonly Permission[] = Object.freeze([IMPORTS_DUPLICATES_MERGE])

/**
 * The role templates that get it (owner: every()): the ones that keep customers and suppliers (finance, sales, buyer)
 * or the material library (buyer, production manager) — each still needs that record type's manage permission.
 */
export const IMPORTS_DUPLICATES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [IMPORTS_DUPLICATES_MERGE],
  sales: [IMPORTS_DUPLICATES_MERGE],
  buyer: [IMPORTS_DUPLICATES_MERGE],
  production_manager: [IMPORTS_DUPLICATES_MERGE],
})
