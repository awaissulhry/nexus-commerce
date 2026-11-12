import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { rateWords } from '@nexus/factory-domain/purchasing/po-depth/currency'
import { dateChangeWords, daysLater, type DateSource } from '@nexus/factory-domain/purchasing/po-depth/dates'
import { usableAddress } from '@nexus/factory-domain/purchasing/po-depth/ship-to'
import type { CommandCaller } from '../../../core/command'
import { receiptTolerancesOf } from '../receiving'
import { dayOf, officeOrder, quantityText, readLines, readOrder, type Reader } from '../store'
import { asAddress, orderTakesRate, readDepthFacts } from './store'

/**
 * GET /purchasing/orders/:purchaseOrderId/depth (purchasing.view; B-W2b-296): what the record's W2b tabs read — the
 * delivery schedule of each line (the days asked, the supplier's days kept apart, confirmed later than needed), the rate at
 * order and the order's value in the company's currency (a cost), where it is delivered and where its receipt lands, the
 * tolerance each line is received with, and the history of every confirmed day (oldest first).
 */
export async function depthOf(db: Reader, orderId: string) {
  const order = (await readOrder(db, orderId))!
  const lines = await readLines(db, order.id)
  const depth = await readDepthFacts(db, order, lines)
  const items = lines.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true } })
  const codes = new Map(items.map((item) => [item.id, item.code]))
  const tolerances = await receiptTolerancesOf(db, { companyId: order.companyId, partyId: order.partyId }, lines)
  const changes =
    lines.length === 0
      ? []
      : await db.poDateChange.findMany({
          where: { purchaseOrderLineId: { in: lines.map((line) => line.id) } },
          select: { id: true, purchaseOrderLineId: true, deliveryId: true, seq: true, fromDate: true, toDate: true, source: true, changedAt: true, supplierContactName: true, reason: true, createdById: true, createdAt: true },
          orderBy: [{ changedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })
  const lineSeq = new Map(lines.map((line) => [line.id, line.seq]))
  const deliverySeq = new Map([...depth.deliveries.values()].flat().map((delivery) => [delivery.id, delivery.seq]))
  const rate = depth.order.rateAtOrder === null ? null : depth.order.rateAtOrder.toString()
  const shipTo = depth.shipTo
  return {
    orderId: order.id,
    number: order.number,
    status: order.status,
    version: order.version,
    currency: {
      order: order.currency,
      company: depth.companyCurrency,
      takesRate: orderTakesRate(depth),
      rateAtOrder: rate,
      rateWords: rate === null ? null : rateWords(rate, order.currency, depth.companyCurrency),
      companyNetAmount: asMoney('cost', depth.order.companyNetAmount),
    },
    shipTo: shipTo
      ? {
          partyId: shipTo.party.id,
          party: { code: shipTo.party.code, name: shipTo.party.name, roles: [...shipTo.party.roles] },
          addressId: depth.order.shipToAddressId,
          address: shipTo.address
            ? { id: shipTo.address.id, name: shipTo.address.name, line1: shipTo.address.line1, line2: shipTo.address.line2, postalCode: shipTo.address.postalCode, city: shipTo.address.city, province: shipTo.address.province, country: shipTo.address.country, contactName: shipTo.address.contactName, phone: shipTo.address.phone, deliveryNotes: shipTo.address.deliveryNotes, usable: usableAddress(asAddress(shipTo.address)) }
            : null,
          locationId: depth.order.shipToLocationId,
          location: shipTo.place ? { code: shipTo.place.code, name: shipTo.place.name } : null,
          receiptLandsAt: shipTo.place ? ('WORKSHOP' as const) : ('OFFICE_PICKS' as const),
        }
      : null,
    lines: lines.map((line) => {
      const needDate = dayOf(line.needDate)!
      const confirmedDate = dayOf(line.confirmedDate)
      return {
        id: line.id,
        seq: line.seq,
        itemId: line.itemId,
        itemCode: codes.get(line.itemId) ?? '',
        quantity: quantityText(line.quantity),
        uom: line.uom,
        baseQuantity: quantityText(line.baseQuantity),
        needDate,
        confirmedDate,
        confirmedLaterBy: daysLater(needDate, confirmedDate),
        ended: line.cancelledAt !== null || line.closedShortAt !== null,
        deliveries: (depth.deliveries.get(line.id) ?? []).map((delivery) => {
          const asked = dayOf(delivery.needDate)!
          const confirmed = dayOf(delivery.confirmedDate)
          return { id: delivery.id, seq: delivery.seq, quantity: quantityText(delivery.quantity), baseQuantity: quantityText(delivery.baseQuantity), needDate: asked, confirmedDate: confirmed, confirmedLaterBy: daysLater(asked, confirmed), note: delivery.note, version: delivery.version }
        }),
        tolerance: tolerances.get(line.id)!,
      }
    }),
    dateChanges: changes.map((change) => {
      const what = change.deliveryId ? `Line ${lineSeq.get(change.purchaseOrderLineId)}, delivery ${deliverySeq.get(change.deliveryId) ?? '?'}` : `Line ${lineSeq.get(change.purchaseOrderLineId)}`
      return {
        id: change.id,
        lineId: change.purchaseOrderLineId,
        lineSeq: lineSeq.get(change.purchaseOrderLineId) ?? 0,
        deliveryId: change.deliveryId,
        deliverySeq: change.deliveryId ? (deliverySeq.get(change.deliveryId) ?? null) : null,
        seq: change.seq,
        fromDate: dayOf(change.fromDate)!,
        toDate: dayOf(change.toDate)!,
        source: change.source as DateSource,
        changedAt: toUtcIso(change.changedAt),
        supplierContactName: change.supplierContactName,
        reason: change.reason,
        words: dateChangeWords({ fromDate: dayOf(change.fromDate)!, toDate: dayOf(change.toDate)!, source: change.source as DateSource, supplierContactName: change.supplierContactName, reason: change.reason, what }),
        createdById: change.createdById,
        createdAt: toUtcIso(change.createdAt),
      }
    }),
  }
}

export type DepthView = Awaited<ReturnType<typeof depthOf>>

/** GET …/depth: the order the caller may see (purchasing.view over its company, site and supplier, else 404). */
export async function getDepth(caller: CommandCaller, orderId: string): Promise<{ depth: DepthView }> {
  const order = await officeOrder(caller, orderId)
  return { depth: await caller.withClient((client) => depthOf(client, order.id)) }
}
