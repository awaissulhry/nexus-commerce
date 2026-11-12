import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Transfers between sites (B-W2b-326; SCM-219, SCM-220; design warehouse.transfers; apps/factory-api
 * modules/inventory/transfers). Area `inventory`, beside the module's own list (inventory/permissions.ts). Office only:
 * W1's inventory.transfer moves stock between two places of ONE site and is shared with the floor; a transfer between
 * sites issues a DDT number (DPR 472/1996) and is posted by the office (the database refuses a floor session).
 *
 *   transfers.manage   draft a transfer and its lines, ship it with its DDT and cancel a draft: checked with can() against
 *                      the SENDING site and its company; receive what arrived and settle a difference: against the
 *                      RECEIVING site and its company. Reading transfers (the list, a transfer, the DDT's PDF) is
 *                      inventory.stock.view at either site.
 */
export const INVENTORY_TRANSFERS_DEFINITIONS = definePermissions('inventory', {
  'transfers.manage': {
    risk: 'write',
    description:
      'Transfers between sites: draft one with its lines, ship it with its DDT (the goods go to the transit place), cancel a draft; at the receiving site, receive what arrived and settle a difference (written off, claimed from the carrier, or sent back).',
  },
})

export const INVENTORY_TRANSFERS_MANAGE = 'inventory.transfers.manage' satisfies Permission
export const INVENTORY_TRANSFERS_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_TRANSFERS_MANAGE])

/**
 * The role templates that hold it (design warehouse.transfers: the warehouse and shipping office). Office only; the Owner
 * from every(). One line per template, merged in auth/roles/templates.ts.
 */
export const TRANSFERS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [INVENTORY_TRANSFERS_MANAGE],
})
