import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Nonconformances (apps/factory-api modules/quality/ncr; B-W2a-47; QHS-080 … QHS-091; design quality.ncr SCR-144 board,
 * SCR-145 record), in the quality area. Each is checked with can() against the NCR's company and site. The design: an
 * NCR is raised from anywhere (an inspection, a bundle, a lot, a receipt, a return, a complaint, a supplier claim, a
 * hold, by hand) by whoever finds the problem; quality follows it up (containment, decisions, carrying them out); a
 * decision that needs approval is approved by another person (four eyes); closing is an e-signature (the office's
 * step-up). Carrying a decision out also needs the right of the record it makes: the stock move's (inventory.scrap,
 * .transfer, .adjust, .issue), the rework order's (production.rework), the supplier claim's (purchasing.claims.manage).
 */
export const QUALITY_NCR_DEFINITIONS = definePermissions('quality', {
  'ncr.view': {
    risk: 'read',
    description: 'See the nonconformances (NCRs) of the sites one reaches: what happened, the containment, the decisions by quantity, what they moved and opened, the linked records and the board.',
  },
  'ncr.raise': {
    risk: 'write',
    description: 'Raise an NCR from an inspection, a bundle, a lot, a hide, a receipt, a return, a complaint, a supplier claim, a hold or by hand, and link records to it.',
  },
  'ncr.manage': {
    risk: 'write',
    description: "Follow an NCR up: its content and owner, its containment actions (a hold through the hold's own right), its decisions by quantity, carrying them out, its stages and cancelling it.",
  },
  'ncr.approve': {
    risk: 'write',
    description: 'Approve a decision of an NCR that needs a second person by its severity or value rule; never one decided by oneself.',
  },
  'ncr.close': {
    risk: 'write',
    description: 'Close an NCR with an e-signature once every quantity is decided and carried out; its holds are closed with it.',
  },
})

export const QUALITY_NCR_VIEW = 'quality.ncr.view' satisfies Permission
export const QUALITY_NCR_RAISE = 'quality.ncr.raise' satisfies Permission
export const QUALITY_NCR_MANAGE = 'quality.ncr.manage' satisfies Permission
export const QUALITY_NCR_APPROVE = 'quality.ncr.approve' satisfies Permission
export const QUALITY_NCR_CLOSE = 'quality.ncr.close' satisfies Permission

export const QUALITY_NCR_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_NCR_VIEW, QUALITY_NCR_RAISE, QUALITY_NCR_MANAGE, QUALITY_NCR_APPROVE, QUALITY_NCR_CLOSE])
