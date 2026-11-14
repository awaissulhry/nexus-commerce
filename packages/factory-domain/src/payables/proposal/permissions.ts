import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Payables in depth (B-W2b-403; FIN-140, FIN-142, FIN-167; PQ1:02), area `payables`, office only; checked with can()
 * against the proposal's company (and each invoice's company and supplier). Reads ride on payables.view (amounts with the
 * cost grain); the leather area check and the subcontract match on payables.view, their actions on purchasing's own
 * permissions (a claim: purchasing.claims.manage; a FEE entry: purchasing.subcontract.cost). Declared in
 * `auth/permissions/catalogue.ts`.
 *
 *   proposals.manage   make the week's payment proposal (the invoices due by due date and discount, each to the supplier's
 *                      verified bank account), change its lines and discounts while a draft, send it back to draft, cancel
 *                      it, and record it paid once the transfers left the bank (every invoice PAID)
 *   proposals.approve  approve a payment proposal for the bank (never one you made; above the amount a second person's yes
 *                      too): a fresh code (step-up), the money that leaves the company
 *   remittance.switch  the Owner's switch: the remittance advice e-mailed to a supplier when its invoices are paid, per
 *                      company (off until the Owner turns it on)
 */
export const PAYABLES_DEPTH_DEFINITIONS = definePermissions('payables', {
  'proposals.manage': {
    risk: 'write',
    description: "Make the week's payment proposal of the supplier invoices due, change its lines while a draft, cancel it, and record it paid once the transfers left the bank.",
  },
  'proposals.approve': {
    risk: 'stepUp',
    description: 'Approve a payment proposal for the bank (never one you made yourself; above the amount a second person approves too). Asks a fresh code.',
  },
  'remittance.switch': {
    risk: 'stepUp',
    description: "Switch on or off the remittance advice e-mailed to a supplier when its invoices are paid (off until the Owner turns it on).",
  },
})

export const PAYABLES_PROPOSALS_MANAGE = 'payables.proposals.manage' satisfies Permission
export const PAYABLES_PROPOSALS_APPROVE = 'payables.proposals.approve' satisfies Permission
export const PAYABLES_REMITTANCE_SWITCH = 'payables.remittance.switch' satisfies Permission

export const PAYABLES_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PAYABLES_PROPOSALS_MANAGE, PAYABLES_PROPOSALS_APPROVE, PAYABLES_REMITTANCE_SWITCH])

/**
 * The role templates that get them (auth/roles/templates; the owner from every()): finance makes and approves the weekly
 * proposal (one person makes it, another approves it). The remittance switch is the Owner's alone (nothing reaches a
 * supplier by itself without the Owner's yes).
 */
export const PAYABLES_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [PAYABLES_PROPOSALS_MANAGE, PAYABLES_PROPOSALS_APPROVE],
})
