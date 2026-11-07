import type { FastifyRequest } from 'fastify'
import { PORTAL_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import { actorOf, requireContext } from '../../core/context'
import { portalSessionOf } from '../auth/portal/authenticator'
import type { HomeSource } from '../portal/home/sources'

/**
 * B-W2b-184 (design portal.customer.home "Revised orders to re-confirm (SAL-222) → Review", portal.*.home "what waits for
 * you"): the approvals the organisation still has to answer, and among them the revised orders to re-confirm (the customer's
 * order readers). Counted in the session's party scope (row-level security); null when the person does not see them.
 */
async function counts(request: FastifyRequest): Promise<{ readonly toAnswer: number | null; readonly reconfirm: number | null }> {
  const session = portalSessionOf(request)
  const actor = actorOf(requireContext(request))
  const scope = { companyId: session.company.id, partyId: session.partyId }
  if (!can(actor, PORTAL_APPROVALS_VIEW, scope)) return { toAnswer: null, reconfirm: null }
  const seesOrders = can(actor, PORTAL_SALES_ORDERS_VIEW, scope)
  return request.withClient(async (client) => ({
    toAnswer: await client.approvalRequest.count({ where: { companyId: session.company.id, status: 'OPEN', ...(seesOrders ? {} : { kind: { not: 'REVISED_ORDER' } }) } }),
    reconfirm: seesOrders ? await client.approvalRequest.count({ where: { companyId: session.company.id, status: 'OPEN', kind: 'REVISED_ORDER' } }) : null,
  }))
}

export const APPROVAL_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'approvals',
  counts: [
    { key: 'approvals.to_answer', area: 'home', kinds: ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR'], words: { it: 'Da approvare', en: 'To approve' } },
    { key: 'orders.to_reconfirm', area: 'orders', kinds: ['CUSTOMER'], words: { it: 'Ordini modificati da riconfermare', en: 'Revised orders to re-confirm' } },
  ],
  async read(_app, request) {
    const found = await counts(request)
    return { 'approvals.to_answer': found.toAnswer, 'orders.to_reconfirm': found.reconfirm }
  },
})
