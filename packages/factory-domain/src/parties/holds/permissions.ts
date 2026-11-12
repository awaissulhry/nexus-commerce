import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Customers in depth (B-W2b-290; SAL-023): an account hold is a decision of its own, apart from editing the customer (as
 * parties.block is): it stops new orders and shipments of a company, or of every company. Checked with can() over the
 * customer and the company it names (a hold of every company: a grant over every company). Requirements, terms per company
 * and riders stay parties.manage; the contacts' personal data has its own (contact-privacy/permissions.ts).
 *
 *   hold   put a customer's account on hold with a reason and words, and release it with words
 */
export const PARTIES_HOLD_DEFINITIONS = definePermissions('parties', {
  hold: {
    risk: 'write',
    description: "Put a customer's account on hold with a reason (new orders and shipments wait, quotes warn) and release it with words.",
  },
})

export const PARTIES_HOLD = 'parties.hold' satisfies Permission
export const PARTIES_HOLD_PERMISSIONS: readonly Permission[] = Object.freeze([PARTIES_HOLD])

/** Who holds it (auth/roles/templates; the owner from every()): finance (credit holds) and sales (data, quality disputes). */
export const PARTIES_HOLD_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [PARTIES_HOLD],
  sales: [PARTIES_HOLD],
})
