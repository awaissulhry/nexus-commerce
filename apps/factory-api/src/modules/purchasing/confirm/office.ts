import { Decimal } from 'decimal.js'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LineChange } from '@nexus/factory-domain/purchasing/confirm/answer'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { confirmLinksOf } from '../confirm-links'
import { dayOf, officeOrder, quantityText, readLines, type OrderRow, type Reader } from '../store'

/**
 * The office's "Supplier's answer" panel of a purchase order (B-W1-31; design plan-buy-pay, record › Confirmations &
 * changes; purchasing.view over the order's company, site and supplier): where the answer stands in words, the
 * confirmation (who typed which name on the link, their reference and note) or the decline with its reasons, per line what
 * was asked against what the supplier confirmed, the evidence rows of the order's links (the name typed, the server time,
 * the hashed client address, the browser) and the links' states. No price: this panel is about quantities and dates.
 */

const ANSWER_WORDS = {
  NOT_SENT: 'Not sent yet: the supplier answers once the order is sent.',
  WAITING: 'Waiting for the supplier to answer its link.',
  CONFIRMED: 'Confirmed by the supplier.',
  DECLINED: 'Declined by the supplier: change the order and send it again, or cancel it.',
  CHANGES_PROPOSED: 'The supplier proposed changes: accept or refuse them.',
  CLOSED: 'The order is past its answer.',
} as const

type AnswerState = keyof typeof ANSWER_WORDS

function answerStateOf(order: Pick<OrderRow, 'status' | 'confirmedAt'>): AnswerState {
  switch (order.status) {
    case 'DRAFT':
      return 'NOT_SENT'
    case 'SENT':
      return 'WAITING'
    case 'DECLINED':
      return 'DECLINED'
    case 'CONFIRMED':
      return 'CONFIRMED'
    default:
      if (String(order.status) === 'CHANGES_PROPOSED') return 'CHANGES_PROPOSED'
      return order.confirmedAt ? 'CONFIRMED' : 'CLOSED'
  }
}

function changesOf(asked: { quantity: Decimal; needDate: string }, quantity: Decimal | null, date: string | null): LineChange[] {
  if (quantity === null) return []
  if (quantity.isZero()) return ['CANNOT_DELIVER']
  const changes: LineChange[] = []
  if (date !== null && date > asked.needDate) changes.push('LATER')
  if (date !== null && date < asked.needDate) changes.push('EARLIER')
  if (quantity.lt(asked.quantity)) changes.push('LESS')
  if (quantity.gt(asked.quantity)) changes.push('MORE')
  return changes
}

async function answerOf(db: Reader, order: OrderRow, now: Date) {
  const lines = await readLines(db, order.id)
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true } })).map((item) => [item.id, item]))
  const colourIds = lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : []))
  const colours = new Map((colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, name: true } })).map((colour) => [colour.id, colour.name]))
  const links = await confirmLinksOf(db, order.id, now)
  const evidence = links.length === 0 ? [] : await db.linkEvidence.findMany({ where: { linkId: { in: links.map((link) => link.id) } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { linkId: true, action: true, at: true, useNumber: true, typedName: true, ipHash: true, userAgent: true } })
  const state = answerStateOf(order)
  return {
    purchaseOrderId: order.id,
    number: order.number,
    status: order.status,
    answer: state,
    words: ANSWER_WORDS[state],
    confirmation: order.confirmedAt && order.confirmedVia ? { at: toUtcIso(order.confirmedAt), via: order.confirmedVia, linkId: order.confirmLinkId, byName: order.confirmedByName, supplierRef: order.supplierRef, note: order.confirmNote } : null,
    decline: order.declinedAt ? { at: toUtcIso(order.declinedAt), reason: order.declineReason } : null,
    lines: lines.map((line) => {
      const item = items.get(line.itemId)
      const asked = { quantity: line.quantity, needDate: dayOf(line.needDate)! }
      const confirmedDate = dayOf(line.confirmedDate)
      return {
        id: line.id,
        seq: line.seq,
        item: { code: item?.code ?? '', name: item?.name ?? '' },
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? null) : null,
        asked: { quantity: quantityText(line.quantity), uom: line.uom, needDate: asked.needDate },
        confirmed: line.confirmedQuantity === null ? null : { quantity: quantityText(line.confirmedQuantity), date: confirmedDate },
        changes: changesOf({ quantity: new Decimal(line.quantity.toString()), needDate: asked.needDate }, line.confirmedQuantity === null ? null : new Decimal(line.confirmedQuantity.toString()), confirmedDate),
      }
    }),
    evidence: evidence.map((row) => ({ linkId: row.linkId, action: row.action, at: toUtcIso(row.at), useNumber: row.useNumber, typedName: row.typedName, ipHash: row.ipHash, userAgent: row.userAgent })),
    links,
  }
}

/** GET /purchasing/orders/:purchaseOrderId/answer (purchasing.view): the supplier's answer on the order. */
export async function orderAnswer(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return caller.withClient((client) => answerOf(client, order, serverClock.now()))
}
