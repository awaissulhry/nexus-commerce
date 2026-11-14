import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The permissions of the actual-cost figures (B-W2b-407; FIN-031, FIN-043, FIN-044; GATE-ACCOUNTANT), in the costing area,
 * office only. Reading the purchase price variances, the cost of goods sold and the landed costs is costing.view;
 * posting a receipt's, an invoice's or a shipment's figures by hand and reversing one is costing.ledger.manage (the cost
 * ledger's own). Every figure is money.cost.
 *
 *   landed.manage    prepare a supplier invoice's charge line as a landed cost over the lots its goods came in (basis,
 *                    lots, weights), change or remove the draft, post it (the lots' cost moves) and reverse it with why
 *   actuals.manage   switch the company's figures for the accountant on or off and choose where it takes its purchase
 *                    price variance (the accountant's word: a fresh step-up)
 */
export const COST_ACTUALS_DEFINITIONS = definePermissions('costing', {
  'landed.manage': {
    risk: 'write',
    description:
      "Land a supplier invoice's freight, duty or broker charge on the lots its goods came in (by value, weight or quantity), change or remove the draft, post it so the lots' cost moves, and reverse a posted one with a reason. Sending a figure needs the cost grain.",
  },
  'actuals.manage': {
    risk: 'stepUp',
    description:
      "Switch a company's figures for the accountant on or off (purchase price variance, cost of goods sold, landed cost, the variances of a work order's close) once the accountant has confirmed the rules, and choose whether the purchase price variance is taken at the receipt or at the supplier's invoice.",
  },
})

export const COSTING_LANDED_MANAGE = 'costing.landed.manage' satisfies Permission
export const COSTING_ACTUALS_MANAGE = 'costing.actuals.manage' satisfies Permission

export const COST_ACTUALS_PERMISSIONS: readonly Permission[] = Object.freeze([COSTING_LANDED_MANAGE, COSTING_ACTUALS_MANAGE])

/** The role templates that get them (owner: every()): finance, who owns landed cost and talks to the accountant. */
export const COST_ACTUALS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [COSTING_LANDED_MANAGE, COSTING_ACTUALS_MANAGE],
})
