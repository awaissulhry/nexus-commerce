import type { Permission } from '../core/permissions'

/**
 * The inventory module's permissions (plan A1 §3.11; SCM-176, SCM-189, SCM-192, SCM-280). Declared with their
 * descriptions in `auth/permissions/catalogue.ts` (INVENTORY_DEFINITIONS), checked with can() against the site's company
 * and the site (a floor device: its own site only). Values (costs) also need the cost grain (`money.cost`).
 */

/** See the locations of a site (the tree, bin codes). Shared with the floor: its own site's locations. */
export const INVENTORY_LOCATIONS_VIEW = 'inventory.locations.view' satisfies Permission
/** Create, rename, move and archive locations; import them from a sheet. */
export const INVENTORY_LOCATIONS_MANAGE = 'inventory.locations.manage' satisfies Permission
/** See the stock: the overview, the stock card of an item, the moves list and the reconciliation check. */
export const INVENTORY_STOCK_VIEW = 'inventory.stock.view' satisfies Permission
/** Correct stock with a reason (an adjustment) and post a count's differences. */
export const INVENTORY_ADJUST = 'inventory.adjust' satisfies Permission
/** Move stock between two locations of one site. Shared with the floor: at its own site. */
export const INVENTORY_TRANSFER = 'inventory.transfer' satisfies Permission
/** Take stock out as scrap, with the reason. */
export const INVENTORY_SCRAP = 'inventory.scrap' satisfies Permission
/** Reverse a stock move (the same move with its locations swapped), with the reason. */
export const INVENTORY_REVERSE = 'inventory.reverse' satisfies Permission

export const INVENTORY_PERMISSIONS = [
  INVENTORY_LOCATIONS_VIEW,
  INVENTORY_LOCATIONS_MANAGE,
  INVENTORY_STOCK_VIEW,
  INVENTORY_ADJUST,
  INVENTORY_TRANSFER,
  INVENTORY_SCRAP,
  INVENTORY_REVERSE,
] as const

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): its site's locations, and transfers there. */
export const INVENTORY_FLOOR_PERMISSIONS = [INVENTORY_LOCATIONS_VIEW, INVENTORY_TRANSFER] as const
