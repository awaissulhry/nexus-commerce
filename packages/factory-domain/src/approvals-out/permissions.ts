import type { Permission } from '../core/permissions'
import { definePartnerPermissions } from '../auth/partners/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Approval requests to partners (B-W2b-184; COL-064, SAL-222, SAL-294, QHS-085). Two sets:
 *
 * The OFFICE's (area `partners`, beside partners.tasks.manage), checked with can() against the request's company and party,
 * and each ask also needs the record's own write permission (a concession quality.ncr.manage, a revised order or a proof
 * sales.orders.manage, a signature safety.risk.manage, a sample of a style product.styles.manage …: platform/approvals-out
 * records.ts):
 *   approvals.view   the requests asked of a customer, supplier or outside signer on a record, their state, the answer
 *                    signed with its evidence (time, typed name, how it came: link or portal)
 *   approvals.ask    ask (an APPROVAL link and the partner's task in one command, the mail), withdraw an open request
 *
 * The PARTNER's (area `portal`, flagged partner: held only by partner roles):
 *   approvals.view   see the requests asked of your organisation; answering also takes portal.approve (B-W2b-162: a
 *                    portal write checks its page's permission AND the capability its verb takes). A revised order also
 *                    needs portal.salesOrders.view (its lines), its prices the price grain.
 */
export const PARTNERS_APPROVALS_DEFINITIONS = definePermissions('partners', {
  'approvals.view': { risk: 'read', description: 'See the approvals asked of customers, suppliers and outside signers on a record: what we asked, by when, and the signed answer with its evidence.' },
  'approvals.ask': { risk: 'write', description: 'Ask a customer, supplier or outside signer to approve a concession, a sample, a colour, a leather, an artwork, a design proof, a revised order or a signature (link and portal), and withdraw an open request.' },
})

export const PARTNERS_APPROVALS_VIEW = 'partners.approvals.view' satisfies Permission
export const PARTNERS_APPROVALS_ASK = 'partners.approvals.ask' satisfies Permission
export const PARTNERS_APPROVALS_PERMISSIONS: readonly Permission[] = Object.freeze([PARTNERS_APPROVALS_VIEW, PARTNERS_APPROVALS_ASK])

export const PORTAL_APPROVALS_DEFINITIONS = definePartnerPermissions('portal', {
  'approvals.view': { risk: 'read', description: 'See what we ask your organisation to approve (samples, colours, leathers, artworks, design proofs, concessions, revised orders) and the answers given; answering takes the right to approve.' },
})

export const PORTAL_APPROVALS_VIEW = 'portal.approvals.view' satisfies Permission
export const PORTAL_APPROVALS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_APPROVALS_VIEW])

/**
 * Who asks and sees (the office templates, one line each; owner from every(), read-only follows the registry): sales asks
 * customers (revised orders, proofs, samples, colours, artworks); the buyer asks suppliers and workshops (samples, leathers,
 * colours); the quality inspector asks concessions; the safety officer asks the outside signers of a DVR version; the
 * administrator all of them; the production manager sees them (a proof holds a release).
 */
export const PARTNERS_APPROVALS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PARTNERS_APPROVALS_VIEW, PARTNERS_APPROVALS_ASK],
  sales: [PARTNERS_APPROVALS_VIEW, PARTNERS_APPROVALS_ASK],
  buyer: [PARTNERS_APPROVALS_VIEW, PARTNERS_APPROVALS_ASK],
  quality_inspector: [PARTNERS_APPROVALS_VIEW, PARTNERS_APPROVALS_ASK],
  safety_officer: [PARTNERS_APPROVALS_VIEW, PARTNERS_APPROVALS_ASK],
  production_manager: [PARTNERS_APPROVALS_VIEW],
})

/** The partner roles that see the requests (answering takes portal.approve): every main role but the invoices-only ones. */
export const PORTAL_APPROVALS_READERS: Readonly<Record<string, readonly Permission[]>> = Object.freeze(
  Object.fromEntries(['customer-buyer', 'customer-quality', 'customer-designer', 'customer-viewer', 'supplier-orders', 'supplier-quality', 'subcontractor-jobs'].map((key) => [key, [PORTAL_APPROVALS_VIEW] as readonly Permission[]])),
)
