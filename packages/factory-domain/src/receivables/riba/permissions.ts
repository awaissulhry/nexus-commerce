import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Collections (B-W2b-402; FIN-112, FIN-113, FIN-126, FIN-128; apps/factory-api modules/receivables/{riba,stops,notices},
 * reminders/approval.ts): checked with can() against the company owed AND the customer; office only. Reads ride on
 * receivables.view; a reminder stop on receivables.reminders.manage; amounts need money.price. Declared in
 * `auth/permissions/catalogue.ts`.
 *
 *   riba.manage          prepare a Ri.Ba. batch (pick the instalments, cancel the draft), make its CBI file for the bank's
 *                        site, settle each item paid or unpaid (paid also needs payments.record: it records the payment)
 *   collections.switch   the Owner's switches (step-up for ON): Ri.Ba. for a company (GATE-ACCOUNTANT) and the payment
 *                        received notice e-mailed to its customers; both OFF by default
 *   reminders.trust      the Owner's: a customer's trusted level (step-up), the highest ladder level whose reminders to it go
 *                        without a person's approval while the company's reminders are switched on
 */
export const COLLECTIONS_DEFINITIONS = definePermissions('receivables', {
  'riba.manage': {
    risk: 'write',
    description: "Prepare a Ri.Ba. batch of the instalments due, make its CBI file for the bank's site, and record each instalment paid or returned unpaid with the bank's fee.",
  },
  'collections.switch': {
    risk: 'stepUp',
    description: "Switch a company's Ri.Ba. collections and its payment received notices to customers on or off (both off until the Owner turns them on).",
  },
  'reminders.trust': {
    risk: 'stepUp',
    description: "Set the reminder level up to which a customer's payment reminders go without a person's approval (only while the company's reminders are switched on).",
  },
})

export const RECEIVABLES_RIBA_MANAGE = 'receivables.riba.manage' satisfies Permission
export const RECEIVABLES_COLLECTIONS_SWITCH = 'receivables.collections.switch' satisfies Permission
export const RECEIVABLES_REMINDERS_TRUST = 'receivables.reminders.trust' satisfies Permission

export const COLLECTIONS_PERMISSIONS: readonly Permission[] = Object.freeze([RECEIVABLES_RIBA_MANAGE, RECEIVABLES_COLLECTIONS_SWITCH, RECEIVABLES_REMINDERS_TRUST])

/**
 * Who gets them (auth/roles/templates; the owner from every()): finance works the Ri.Ba. batches. The two switches and the
 * trusted levels are the Owner's alone (nothing goes to a bank or a customer by itself without the Owner's yes).
 */
export const COLLECTIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [RECEIVABLES_RIBA_MANAGE],
})
