import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Shipment holds (B-W2b-386; LOG-017, FIN-079): put a shipment on hold with a reason and words, release it with words.
 * Checked with can() against the shipment's company, site and party. Office only (the floor reads a hold's reason, never
 * its words, and places none). Reading the holds needs shipping.view. LOG-017 "only allowed roles release": a money hold
 * (credit, deposit, balance before shipping) and any hold the system placed need shipping.holds.release as well; the
 * others shipping.holds.manage alone (every hold route asks shipping.holds.manage). Nothing here carries money. Declared in
 * `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_HOLDS_DEFINITIONS = definePermissions('shipping', {
  'holds.manage': {
    risk: 'write',
    description:
      "Put shipments that have not left on hold with a reason (credit, deposit, balance unpaid, quality, the customer's request, another reason) and words: they can no longer be packed, labelled or leave; release a hold for quality, the customer's request or another reason, with words.",
  },
  'holds.release': {
    risk: 'write',
    description:
      'With shipping.holds.manage: release, with words, a shipment held for credit, an unpaid deposit or an unpaid balance before shipping, and any hold the system placed (the account on hold, over the credit limit, the balance before shipping).',
  },
})

export const SHIPPING_HOLDS_MANAGE = 'shipping.holds.manage' satisfies Permission
export const SHIPPING_HOLDS_RELEASE = 'shipping.holds.release' satisfies Permission

export const SHIPPING_HOLDS_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_HOLDS_MANAGE, SHIPPING_HOLDS_RELEASE])

/**
 * Who holds them (auth/roles/templates; the owner from every(), the read-only role none: writes): the warehouse (the
 * dispatch desk works the queue every day) places holds and releases its own kinds; finance places holds and releases every
 * kind, the money holds and the system's included.
 */
export const SHIPPING_HOLDS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [SHIPPING_HOLDS_MANAGE],
  finance: [SHIPPING_HOLDS_MANAGE, SHIPPING_HOLDS_RELEASE],
})
