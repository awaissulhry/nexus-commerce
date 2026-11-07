import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PORTAL_PURCHASE_ORDERS_VIEW } from '@nexus/factory-domain/purchasing/portal-orders/permissions'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf } from '../../../platform/auth/portal/authenticator'
import { systemCallerOf } from '../../../platform/files/files'
import { expectedLinesOf } from '../orders'

/**
 * The supplier Home's counts of purchase orders (B-W2b-174; platform/portal/home/sources/purchase-orders.ts): those waiting
 * for its answer (SENT, in the session's own scope) and those late (an open line still waiting for goods past its confirmed
 * date, else the date asked: the receipts are read in the system scope for this party's orders, quantities only). Null when
 * the person does not see purchase orders (fails closed: a count they could not open is not shown).
 */
export async function portalOrderCounts(request: FastifyRequest, now: Date): Promise<{ readonly toConfirm: number; readonly late: number } | null> {
  const session = portalSessionOf(request)
  if (!can(actorOf(requireContext(request)), PORTAL_PURCHASE_ORDERS_VIEW, { companyId: session.company.id, partyId: session.partyId })) return null
  const toConfirm = await request.withClient((client) => client.purchaseOrder.count({ where: { companyId: session.company.id, status: 'SENT' } }))
  const expected = await systemCallerOf(request)(session.tenantId).withClient((client) => expectedLinesOf(client as Prisma.TransactionClient, [{ partyId: session.partyId, companyId: session.company.id }], businessDate(now)))
  const late = new Set(expected.lines.filter((line) => line.state === 'LATE').map((line) => line.purchaseOrderId)).size
  return { toConfirm, late }
}
