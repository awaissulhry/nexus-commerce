import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { portalOrderRequestWords } from '@nexus/factory-domain/insights/words'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { capped, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * Order requests customers sent from the portal (B-W2b-190, SAL-074 "portal orders arrive as requests"; design
 * home.approvals "One inbox for every request that needs my yes", portal.customer.neworder conn "the request waits there
 * as Requested"). A SENT request waits for the office of its company and customer: the person decides it when they take
 * that customer's orders (orders.manage: insights/attention's act). The row opens the request's record, where the order
 * or a quote is made from it, or it is refused in words. Oldest first; the customer was promised an answer within one
 * working day, so a request sent before today is urgent.
 */

export const portalOrderRequest: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.PortalOrderRequestWhereInput
  return caller.withClient(async (db) => {
    const found = await db.portalOrderRequest.findMany({
      where: { AND: [scope, { status: 'SENT' }] },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, number: true, companyId: true, partyId: true, sentAt: true, lines: { select: { sizes: { select: { quantity: true } } } } },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const today = viewer.today
    const candidates: AttentionCandidate[] = rows.map((row) => {
      const pieces = row.lines.reduce((sum, line) => sum + line.sizes.reduce((inner, size) => inner + size.quantity, 0), 0)
      const sentDay = row.sentAt ? row.sentAt.toISOString().slice(0, 10) : today
      return {
        kind: 'PORTAL_ORDER_REQUEST',
        state: 'WAITING_DECISION',
        severity: sentDay < today ? 'HIGH' : 'MEDIUM',
        record: { type: 'PortalOrderRequest', id: row.id, label: row.number ?? 'Order request' },
        scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
        ...portalOrderRequestWords({ number: row.number ?? '', customer: names.get(row.partyId) ?? 'a customer', lines: row.lines.length, pieces }),
        due: null,
        since: row.sentAt ?? new Date(0),
        notBy: [],
      }
    })
    return { kind: 'PORTAL_ORDER_REQUEST', candidates, complete }
  })
}
