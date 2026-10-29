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
/**
 * Pick and issue stock to a work order, return what it did not use, undo one's own last issue (B-W1-39; SCM-215).
 * Shared with the floor: at its own site.
 */
export const INVENTORY_ISSUE = 'inventory.issue' satisfies Permission
/** Issue more than a work order still needs, with the reason (B-W1-39; office only). */
export const INVENTORY_ISSUE_OVER = 'inventory.issue.over' satisfies Permission
/**
 * Receive goods against a purchase order: the receipt, its lots and hides one by one, posted to the ledger (B-W1-32;
 * SCM-113). Shared with the floor (B-W1-33: the receiving screen at its own site). Reversing a receipt is
 * inventory.reverse (the office); releasing a lot is the quality step's (B-W1-34).
 */
export const INVENTORY_RECEIVE = 'inventory.receive' satisfies Permission

export const INVENTORY_PERMISSIONS = [
  INVENTORY_LOCATIONS_VIEW,
  INVENTORY_LOCATIONS_MANAGE,
  INVENTORY_STOCK_VIEW,
  INVENTORY_ADJUST,
  INVENTORY_TRANSFER,
  INVENTORY_SCRAP,
  INVENTORY_REVERSE,
  INVENTORY_ISSUE,
  INVENTORY_ISSUE_OVER,
  INVENTORY_RECEIVE,
] as const

/**
 * What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): its site's locations, transfers there, picking and
 * issuing to its site's work orders, and receiving goods there (B-W1-33); never an over-issue, never a reversal: the
 * office's.
 */
export const INVENTORY_FLOOR_PERMISSIONS = [INVENTORY_LOCATIONS_VIEW, INVENTORY_TRANSFER, INVENTORY_ISSUE, INVENTORY_RECEIVE] as const
