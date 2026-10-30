import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Repairs and alterations (B-W2a-57; SAL-383 repair order from a case, SAL-390 repair stages, LOG-116 repair round trip;
 * design sales.returns "Repair order"), in the sales area (the role matrix's Sales group, beside the returns). Each is
 * checked with can() against the repair's company, its site (the site that repairs it) and its customer, so a role
 * limited to some customers or sites sees and acts on only theirs. Office only: the floor reads no repair yet (the
 * floor's repair queue is W2b, MES-132).
 *
 *   view     the returns and repairs list's repairs and tiles, a repair with its stages, its repair work order, its
 *            safety check and its DDTs, the garment's other repairs (no amount: a repair shows none in W2a)
 *   manage   make a repair or an alteration (from an RMA line decided Repair, from a complaint, or by hand), change its
 *            problem, garment, owner and notes, move it through its stages (estimated, approved, in repair, repaired;
 *            back into repair), cancel it
 *   receive  record the garment's arrival for a repair that waits for it, with the customer's DDT (DPR 472/1996)
 *   check    sign the safety check of a repaired protective garment (PPE): seams, abrasion zones, closures, protectors
 *            (lot and level of a replaced one), the certificate still covers it; an e-signature (the office's step-up)
 *   ship     send the garment back to the customer with its DDT (reason REPAIR or RETURN_FROM_WORK): issuing the DDT in
 *            the same step also needs shipping.ddt.issue
 */
export const SALES_REPAIRS_DEFINITIONS = definePermissions('sales', {
  'repairs.view': { risk: 'read', description: "See repairs and alterations of customers' garments: the stages, the repair work order, the safety check of a protective garment, the transport documents and the garment's other repairs." },
  'repairs.manage': { risk: 'write', description: 'Make a repair or alteration (from a return line decided Repair, a complaint, or by hand), change it, move it through its stages (estimated, approved, in repair, repaired) and cancel it.' },
  'repairs.receive': { risk: 'write', description: "Record that a customer's garment arrived for its repair, with the customer's transport document (DDT)." },
  'repairs.check': { risk: 'write', description: 'Sign the safety check of a repaired protective garment (seams, abrasion zones, closures, protectors, the certificate still covers it) with an e-signature: it goes back only after a passed check.' },
  'repairs.ship': { risk: 'write', description: 'Send a repaired (or unrepaired) garment back to the customer with its transport document; issuing the DDT in the same step also needs the right to issue DDTs.' },
})

export const SALES_REPAIRS_VIEW = 'sales.repairs.view' satisfies Permission
export const SALES_REPAIRS_MANAGE = 'sales.repairs.manage' satisfies Permission
export const SALES_REPAIRS_RECEIVE = 'sales.repairs.receive' satisfies Permission
export const SALES_REPAIRS_CHECK = 'sales.repairs.check' satisfies Permission
export const SALES_REPAIRS_SHIP = 'sales.repairs.ship' satisfies Permission

export const SALES_REPAIRS_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_REPAIRS_VIEW, SALES_REPAIRS_MANAGE, SALES_REPAIRS_RECEIVE, SALES_REPAIRS_CHECK, SALES_REPAIRS_SHIP])
