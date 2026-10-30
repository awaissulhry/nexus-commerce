import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Customer returns (B-W2a-43; SAL-333, SAL-335, SAL-340, SAL-341, SAL-352, SAL-362, LOG-114, QHS-117; design
 * sales.returns "Return (RMA)" and floor.returnsin), in the sales area (the role matrix's Sales group). Each is checked
 * with can() against the RMA's company, its site (the site the goods come back to) and its customer, so a role limited
 * to some customers or sites sees and acts on only theirs. The floor holds two of them (FLOOR_SHARED_PERMISSIONS): the
 * dock of the RMA's site receives the goods and grades them, never a price, a credit or a decision.
 *
 *   view     the returns list and its tiles, an RMA with its lines, dock receipts, grades, decisions and status steps,
 *            the return policy in force (prices and credit values only with the price grain)
 *   manage   make an RMA from what the customer was invoiced (or shipped), change what comes back before the goods
 *            arrive, the owner, deadline and notes; cancel one before the goods arrive; close one with its finish reason
 *   receive  record the goods' arrival at the dock: parcels, their condition and photos, the customer's DDT, the pieces
 *            of each line (office, and the floor at its own site)
 *   inspect  grade each returned garment and say what caused the problem, with photos (office, and the floor's
 *            inspector at its own site)
 *   decide   decide each graded line: what the customer gets (repair, replace, credit, back unchanged, scrap), where the
 *            goods go (stock, second quality, quarantine, repair, scrap, back), the credit value; make the replacement
 *            order (with orders.manage)
 */
export const SALES_RETURNS_DEFINITIONS = definePermissions('sales', {
  'returns.view': { risk: 'read', description: 'See customer returns (RMAs): what comes back, the dock receipts, grades and decisions, the status steps and the return policy (credit values only with the price grain).' },
  'returns.manage': { risk: 'write', description: "Make an RMA from the customer's invoiced or shipped lines (never more than sold), change what comes back before the goods arrive, cancel it then, or close it with its finish reason." },
  'returns.receive': { risk: 'write', description: "Record a return's arrival at the dock: parcels, their condition and photos, the customer's DDT and the pieces of each line (a floor device: at its own site)." },
  'returns.inspect': { risk: 'write', description: 'Grade each returned garment (new to unusable), say what caused the problem and add photos (a floor device: at its own site).' },
  'returns.decide': { risk: 'write', description: 'Decide each graded line: what the customer gets, where the goods go (stock moves follow) and the credit value; make the replacement order.' },
})

export const SALES_RETURNS_VIEW = 'sales.returns.view' satisfies Permission
export const SALES_RETURNS_MANAGE = 'sales.returns.manage' satisfies Permission
export const SALES_RETURNS_RECEIVE = 'sales.returns.receive' satisfies Permission
export const SALES_RETURNS_INSPECT = 'sales.returns.inspect' satisfies Permission
export const SALES_RETURNS_DECIDE = 'sales.returns.decide' satisfies Permission

export const SALES_RETURNS_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_RETURNS_VIEW, SALES_RETURNS_MANAGE, SALES_RETURNS_RECEIVE, SALES_RETURNS_INSPECT, SALES_RETURNS_DECIDE])

/** What the dock's tablet does at its own site (never a price, a credit or a decision). */
export const SALES_RETURNS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_RETURNS_RECEIVE, SALES_RETURNS_INSPECT])
