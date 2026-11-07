import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { PORTAL_SHIP_NOTICES_VIEW } from '@nexus/factory-domain/purchasing/ship-notices/permissions'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf } from '../../../platform/auth/portal/authenticator'
import { systemCallerOf } from '../../../platform/files/files'
import type { HomeSource } from '../../../platform/portal/home/sources/index'
import { expectedLinesOf } from '../orders'

/**
 * The supplier Home's counts of deliveries (B-W2b-182; design portal.supplier.home "Deliveries to announce (confirmed lines
 * due in 7 days without a ship notice)"; platform/portal/home/sources): the confirmed orders with a line due within 7 days
 * that no notice announces yet (sent or a draft), and the notices on their way (sent, not received). Null when the person
 * does not see ship notices (their role): a count they could not open is not shown.
 */
export async function deliveryCounts(request: FastifyRequest, now: Date): Promise<{ readonly toAnnounce: number; readonly onTheWay: number } | null> {
  const session = portalSessionOf(request)
  if (!can(actorOf(requireContext(request)), PORTAL_SHIP_NOTICES_VIEW, { companyId: session.company.id, partyId: session.partyId })) return null
  const today = businessDate(now)
  const onTheWay = await request.withClient((client) => client.shipNotice.count({ where: { companyId: session.company.id, status: 'SENT' } }))
  const announced = new Set(
    (await request.withClient((client) => client.shipNoticeLine.findMany({ where: { shipNotice: { companyId: session.company.id, status: { in: ['DRAFT', 'SENT'] } } }, select: { purchaseOrderLineId: true } }))).map((line) => line.purchaseOrderLineId),
  )
  // The open lines are read in the system scope for this party's confirmed orders (quantities only, as the orders' counts).
  const expected = await systemCallerOf(request)(session.tenantId).withClient((client) =>
    expectedLinesOf(client as Prisma.TransactionClient, [{ partyId: session.partyId, companyId: session.company.id }, { status: { in: ['CONFIRMED', 'PARTLY_RECEIVED'] } }], today),
  )
  const soon = addDays(today, 7)
  const toAnnounce = new Set(expected.lines.filter((line) => line.expectedDate <= soon && !announced.has(line.lineId)).map((line) => line.purchaseOrderId)).size
  return { toAnnounce, onTheWay }
}

export const SHIP_NOTICE_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'ship-notices',
  counts: [
    { key: 'deliveries.to_announce', area: 'deliveries', kinds: ['SUPPLIER'], words: { it: 'Consegne da annunciare', en: 'Deliveries to announce' } },
    { key: 'deliveries.on_the_way', area: 'deliveries', kinds: ['SUPPLIER'], words: { it: 'Consegne in arrivo', en: 'Deliveries on their way' } },
  ],
  async read(_app, request, now) {
    const counts = await deliveryCounts(request, now)
    return { 'deliveries.to_announce': counts?.toAnnounce ?? null, 'deliveries.on_the_way': counts?.onTheWay ?? null }
  },
})
