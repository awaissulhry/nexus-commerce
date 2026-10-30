import { definePermissions } from '../auth/permissions/registry'
import type { Permission } from '../core/permissions'

/**
 * Payables (apps/factory-api modules/payables; B-W2a-62; FIN-136 supplier invoice capture, FIN-137 three-way match;
 * design finance.payables, SCR-153). Area `payables`. Every act is checked with can() against the invoice's company AND
 * its supplier (the party), so a role limited to some suppliers reaches only theirs. Office only: the floor, portal and
 * link sessions read none of it (the supplier portal is W2b). Every amount and price also needs the cost grain
 * (money.cost): without it they are not sent.
 *
 *   view                 the supplier invoices, their tiles, a record's lines, three-way match, approval and payment, the
 *                        XML or PDF as received, the SDI pickups
 *   manage               register an invoice typed from its PDF (a foreign supplier's, or one sent by e-mail), correct or
 *                        void a typed one, map lines to purchase or subcontract order lines, redo the match, send the
 *                        differences to the buyer, dispute an invoice and reopen it, settle a supplier claim with its
 *                        credit note, pick up from SDI now
 *   differences.accept   accept a difference outside the tolerance, in words (the buyer, who knows what was agreed)
 *   approve              approve an invoice for payment (never the person who registered it: separation of duties),
 *                        withdraw the approval before payment
 *   pay                  record the payment: the day the transfer left the bank and its reference (the payment proposal
 *                        is W2b)
 */
export const PAYABLES_DEFINITIONS = definePermissions('payables', {
  view: {
    risk: 'read',
    description: 'See the supplier and subcontractor invoices, their lines, the three-way match against orders and receipts, the approval and payment, and the invoice as received (amounts only with the cost grain).',
  },
  manage: {
    risk: 'write',
    description: 'Register supplier invoices typed from their PDF, correct or void a typed one, map invoice lines to order lines, redo the match, send differences to the buyer, dispute an invoice, and pick up from SDI now.',
  },
  'differences.accept': {
    risk: 'write',
    description: 'Accept, in words, a difference between a supplier invoice and what was ordered and received that is outside the tolerance.',
  },
  approve: {
    risk: 'write',
    description: 'Approve a matched supplier invoice for payment (never one you registered yourself), or withdraw the approval before payment.',
  },
  pay: {
    risk: 'write',
    description: 'Record that an approved supplier invoice was paid: the day the transfer left the bank and its reference.',
  },
})

export const PAYABLES_VIEW = 'payables.view' satisfies Permission
export const PAYABLES_MANAGE = 'payables.manage' satisfies Permission
export const PAYABLES_DIFFERENCES_ACCEPT = 'payables.differences.accept' satisfies Permission
export const PAYABLES_APPROVE = 'payables.approve' satisfies Permission
export const PAYABLES_PAY = 'payables.pay' satisfies Permission

export const PAYABLES_PERMISSIONS: readonly Permission[] = Object.freeze([PAYABLES_VIEW, PAYABLES_MANAGE, PAYABLES_DIFFERENCES_ACCEPT, PAYABLES_APPROVE, PAYABLES_PAY])
