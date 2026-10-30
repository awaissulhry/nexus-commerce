import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Customer price lists (B-W2a-19; SAL-165; apps/factory-api modules/sales/pricelists; design sales.pricelists), in their
 * own area. Checked with can() against the list's company; a list of every company (no company) is changed only by a
 * grant over every company. Office only: no list price on the floor or on a supplier link. Prices are the price grain
 * (money.price); a price row's standard cost the cost grain, its margin the margin grain.
 *
 *   view    the lists, their dated versions, their prices, the customers priced from them, two versions compared
 *   manage  make a list and its next version, edit a draft's prices, activate a version from a day (the version before
 *           it ends the day before), end an active one, give the list to customers, archive and reactivate a list
 */
export const PRICE_LISTS_DEFINITIONS = definePermissions('pricelists', {
  view: { risk: 'read', description: 'See the price lists, their dated versions and prices, and the customers priced from them (prices with the price grain; cost and margin with theirs).' },
  manage: { risk: 'write', description: "Make price lists and their next versions, edit a draft version's prices, activate a version from a day, end one, give a list to customers, archive and reactivate a list." },
})

export const PRICE_LISTS_VIEW = 'pricelists.view' satisfies Permission
export const PRICE_LISTS_MANAGE = 'pricelists.manage' satisfies Permission
export const PRICE_LISTS_PERMISSIONS: readonly Permission[] = Object.freeze([PRICE_LISTS_VIEW, PRICE_LISTS_MANAGE])
