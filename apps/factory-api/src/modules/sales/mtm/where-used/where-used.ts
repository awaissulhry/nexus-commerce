import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import type { ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import type { WhereUsedView } from '@nexus/factory-domain/sales/mtm/where-used'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { actorOf } from '../../../../core/context'
import { officeOf, OPEN_ORDER_STATES } from '../store'

/**
 * GET /product/measurement-templates/:templateId/where-used (B-W2b-371, XF2:04; design template.whereused): the styles measured with
 * the template, newest code first, and the open orders whose made-to-measure units it serves — a unit of a style measured with it,
 * or of a rider measured for its garment type (the template's code) — each order with its units (line, style and colourway, base
 * size, the revision it is made to and its review). product.styles.view over the template's company (else not found); the styles
 * the caller reads; the orders only over the caller's orders.view (companies and customers; none held: `orders` null), at most 100
 * newest first (`moreOrders`); a unit's rider only over sales.measurements.view for its customer (else null). No money.
 */

const ORDERS_CAP = 100

export async function templateWhereUsed(request: FastifyRequest, templateId: string): Promise<WhereUsedView> {
  const context = officeOf(request)
  const actor = actorOf(context)
  const template = isUuid(templateId) ? await request.withClient((db) => db.measurementTemplate.findUnique({ where: { id: templateId }, select: { id: true, code: true, companyId: true } })) : null
  if (!template || !can(actor, PRODUCT_STYLES_VIEW, { companyId: template.companyId })) throw new NotFoundError('Measurement template not found.')
  return request.withClient(async (db) => {
    const styles = await db.style.findMany({
      where: { AND: [{ measurementTemplateId: template.id }, scopeWhere(actor, PRODUCT_STYLES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.StyleWhereInput] },
      select: { id: true, code: true, name: true, season: true, status: true, lifecycle: true, mtmAllowed: true, companyId: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    })
    if (!holds(actor, ORDERS_VIEW)) return { template: { id: template.id, code: template.code }, styles: styles.map(styleView), orders: null, moreOrders: false }
    const lines = await db.salesOrderLine.findMany({
      where: {
        AND: [
          { kind: 'MADE_TO_MEASURE', closedShortAt: null, order: { status: { in: [...OPEN_ORDER_STATES] } } },
          { OR: [{ style: { measurementTemplateId: template.id } }, { measurementProfile: { garmentType: template.code } }] },
          { order: scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput },
        ],
      },
      select: { id: true, orderId: true, seq: true, styleId: true, colourwayId: true, baseSize: true, measurementProfileId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 1000,
    })
    const orderIds = [...new Set(lines.map((line) => line.orderId))]
    const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, status: true, companyId: true, partyId: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const shown = orders.slice(0, ORDERS_CAP)
    const parties = new Map((shown.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(shown.map((order) => order.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
    const styleCodes = new Map((lines.length === 0 ? [] : await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const colourways = new Map((lines.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const profileIds = [...new Set(lines.flatMap((line) => (line.measurementProfileId ? [line.measurementProfileId] : [])))]
    const profiles = new Map((profileIds.length === 0 ? [] : await db.measurementProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, partyId: true, riderName: true, revision: true, reviewStatus: true } })).map((row) => [row.id, row]))
    return {
      template: { id: template.id, code: template.code },
      styles: styles.map(styleView),
      orders: shown.map((order) => {
        const party = parties.get(order.partyId)
        return {
          id: order.id,
          number: order.number,
          status: order.status,
          companyId: order.companyId,
          customer: { id: order.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
          units: lines
            .filter((line) => line.orderId === order.id && line.measurementProfileId !== null)
            .sort((a, b) => a.seq - b.seq)
            .flatMap((line) => {
              const profile = profiles.get(line.measurementProfileId!)
              if (!profile) return []
              return [
                {
                  lineId: line.id,
                  seq: line.seq,
                  style: { id: line.styleId, code: styleCodes.get(line.styleId) ?? '' },
                  colourway: colourways.get(line.colourwayId) ?? '',
                  baseSize: line.baseSize,
                  profile: { id: profile.id, revision: profile.revision, review: profile.reviewStatus as ReviewStatus },
                  rider: can(actor, SALES_MEASUREMENTS_VIEW, { partyId: profile.partyId }) ? profile.riderName : null,
                },
              ]
            }),
        }
      }),
      moreOrders: orders.length > ORDERS_CAP,
    }
  })
}

const styleView = (style: { id: string; code: string; name: string; season: string | null; status: string; lifecycle: string; mtmAllowed: boolean; companyId: string | null }) => ({
  id: style.id,
  code: style.code,
  name: style.name,
  season: style.season,
  status: style.status,
  lifecycle: style.lifecycle,
  madeToMeasure: style.mtmAllowed,
  companyId: style.companyId,
})
