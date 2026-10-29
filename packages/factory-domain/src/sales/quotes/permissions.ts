import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The quotes' permissions (apps/factory-api modules/sales/quotes; B-W1-21; SAL-143, SAL-172, SAL-184, SAL-203, SAL-268;
 * A2 SCR-030, SCR-034, SCR-035), in the quotes area. Each is checked with can() against the quote's company AND its
 * party, so a role limited to some customers sees and quotes only those.
 *
 *   view     the quotes list and the record: header, lines with their size grids, totals and VAT, the approval rules
 *            and requests, the issues; prices only with the price grain, costs with the cost grain, margins with the
 *            margin grain (the margin AMOUNT also needs the cost grain: net − margin is the cost)
 *   manage   create a quote, edit its header and its lines (size grids), recompute it, ask for an approval and withdraw
 *            the request, cancel it
 *   approve  decide an approval request: approve or reject (with a reason). Apart from editing: the person who asked
 *            never decides their own request, and a request that names the margin floor needs the margin grain
 */
export const QUOTES_DEFINITIONS = definePermissions('quotes', {
  view: { risk: 'read', description: 'See quotes: lines and size grids, totals and VAT, approval rules and requests, what stops a quote (prices, costs and margins only with their grains).' },
  manage: { risk: 'write', description: 'Make and edit quotes: header, lines and size grids; recompute them, ask for an approval, withdraw it, cancel a quote.' },
  approve: { risk: 'write', description: "Approve or reject a quote's approval request (never one you asked for yourself)." },
})

export const QUOTES_VIEW = 'quotes.view' satisfies Permission
export const QUOTES_MANAGE = 'quotes.manage' satisfies Permission
export const QUOTES_APPROVE = 'quotes.approve' satisfies Permission
export const QUOTES_PERMISSIONS: readonly Permission[] = Object.freeze([QUOTES_VIEW, QUOTES_MANAGE, QUOTES_APPROVE])
