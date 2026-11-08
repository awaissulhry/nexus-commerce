import { Decimal } from 'decimal.js'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LineChange } from '@nexus/factory-domain/purchasing/confirm/answer'
import { portalAnswerSummary, portalCountsOf, portalLineOfStored } from '@nexus/factory-domain/purchasing/portal-orders/answer'
import { proposedLineOf } from '@nexus/factory-domain/purchasing/confirm/proposal'
import { PO_RECORD_TYPE } from '@nexus/factory-domain/purchasing/portal-orders/views'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { tasksOfRecord } from '../../../platform/portal/tasks/store'
import { confirmLinksOf } from '../confirm-links'
import { dayOf, officeOrder, quantityText, readLines, type OrderRow, type Reader } from '../store'
import { PROPOSAL_ORDER_COLUMNS, proposalLinesOf } from './decide'

/**
 * The office's "Supplier's answer" panel of a purchase order (B-W1-31; design plan-buy-pay, record › Confirmations &
 * changes; purchasing.view over the order's company, site and supplier): where the answer stands in words, the
 * confirmation (who typed which name on the link, or which person of the supplier confirmed it in the portal (`via`
 * PORTAL, B-W2b-F13a); their reference and note) or the decline with its reasons, the
 * supplier's latest proposal with the buyer's decision, per line what was asked against what the supplier proposed and
 * confirmed, the evidence rows of the order's links (the name typed, the server time,
 * the hashed client address, the browser) and the links' states. No price: this panel is about quantities and dates.
 */

/**
 * Where the answer stands, in Italian and English (B-W2b-F15: it/en). WAITING says where the supplier answers
 * (`waitingOn`): its emailed link, the portal (its portal is on and the order's CONFIRM_PO request is open there), or both
 * while the link is still open too.
 */
const ANSWER_WORDS = {
  NOT_SENT: { en: 'Not sent yet: the supplier answers once the order is sent.', it: "Non ancora inviato: il fornitore risponde quando l'ordine è inviato." },
  CONFIRMED: { en: 'Confirmed by the supplier.', it: 'Confermato dal fornitore.' },
  DECLINED: { en: 'Declined by the supplier: change the order and send it again, or cancel it.', it: "Rifiutato dal fornitore: modifica l'ordine e invialo di nuovo, oppure annullalo." },
  CHANGES_PROPOSED: { en: 'The supplier proposed changes: accept or refuse them.', it: 'Il fornitore ha proposto modifiche: accettale o rifiutale.' },
  CLOSED: { en: 'The order is past its answer.', it: "L'ordine ha superato la fase di risposta." },
} as const

/** The contract's `waitingOn` (./contract.ts). */
type WaitingOn = 'LINK' | 'PORTAL' | 'PORTAL_OR_LINK'

const WAITING_WORDS: Readonly<Record<WaitingOn, { readonly en: string; readonly it: string }>> = Object.freeze({
  LINK: { en: 'Waiting for the supplier to answer its link.', it: 'In attesa che il fornitore risponda dal suo link.' },
  PORTAL: { en: 'Waiting for the supplier to answer in the portal.', it: 'In attesa che il fornitore risponda nel portale.' },
  PORTAL_OR_LINK: { en: 'Waiting for the supplier to answer in the portal or by its link.', it: 'In attesa che il fornitore risponda nel portale o dal suo link.' },
})

type AnswerState = keyof typeof ANSWER_WORDS | 'WAITING'

/** Where a sent order's answer can come from: the portal (on, with the order's request open there), its open link, or both. */
async function waitingOnOf(db: Reader, order: Pick<OrderRow, 'id' | 'partyId'>, links: readonly { readonly state: string }[]): Promise<WaitingOn> {
  const portalOn = (await db.portalSettings.findFirst({ where: { partyId: order.partyId }, select: { portalOn: true } }))?.portalOn === true
  const inPortal = portalOn && (await tasksOfRecord(db, PO_RECORD_TYPE, order.id, { kinds: ['CONFIRM_PO'], status: 'OPEN' })).length > 0
  if (!inPortal) return 'LINK'
  return links.some((link) => link.state === 'LIVE') ? 'PORTAL_OR_LINK' : 'PORTAL'
}

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
  const waitingOn = state === 'WAITING' ? await waitingOnOf(db, order, links) : null
  const proposal = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, select: PROPOSAL_ORDER_COLUMNS })
  // B-W2b-174 (SCM-086): with the substitute the supplier offers and whether the line waits for the buyer's yes.
  const extras = new Map((await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, select: { id: true, proposedSubstituteItemId: true, proposedSubstituteNote: true, proposalNeedsBuyer: true } })).map((row) => [row.id, row]))
  const proposed = new Map((await proposalLinesOf(db, order.id)).flatMap((line) => {
    const read = proposedLineOf(line)
    const extra = extras.get(line.id)
    return read ? [[line.id, extra ? portalLineOfStored(read, extra) : portalLineOfStored(read, { proposedSubstituteItemId: null, proposedSubstituteNote: null, proposalNeedsBuyer: false })] as const] : []
  }))
  const substituteIds = [...new Set([...proposed.values()].flatMap((line) => (line.substitute?.itemId ? [line.substitute.itemId] : [])))]
  const substituteItems = new Map((substituteIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: substituteIds } }, select: { id: true, code: true, name: true } })).map((item) => [item.id, item]))
  return {
    purchaseOrderId: order.id,
    number: order.number,
    status: order.status,
    answer: state,
    waitingOn,
    words: waitingOn !== null ? WAITING_WORDS[waitingOn] : ANSWER_WORDS[state as keyof typeof ANSWER_WORDS],
    confirmation: order.confirmedAt && order.confirmedVia ? { at: toUtcIso(order.confirmedAt), via: order.confirmedVia, linkId: order.confirmLinkId, byName: order.confirmedByName, supplierRef: order.supplierRef, note: order.confirmNote } : null,
    decline: order.declinedAt ? { at: toUtcIso(order.declinedAt), reason: order.declineReason } : null,
    proposal: proposal.proposedAt
      ? {
          at: toUtcIso(proposal.proposedAt),
          // A proposal names exactly one of its link and its portal person (the …_portal_followups_w2b guard).
          via: proposal.proposalLinkId ? ('LINK' as const) : ('PORTAL' as const),
          linkId: proposal.proposalLinkId,
          byName: proposal.proposedByName,
          supplierRef: proposal.proposalSupplierRef,
          note: proposal.proposalNote,
          summary: portalAnswerSummary(portalCountsOf([...proposed.values()])),
          decision: proposal.proposalDecision,
          decidedAt: proposal.proposalDecidedAt ? toUtcIso(proposal.proposalDecidedAt) : null,
          decidedById: proposal.proposalDecidedById,
          decisionNote: proposal.proposalDecisionNote,
        }
      : null,
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
        proposed: (() => {
          const read = proposed.get(line.id)
          if (!read) return null
          const substitute = read.substitute ? { itemId: read.substitute.itemId, code: read.substitute.itemId ? (substituteItems.get(read.substitute.itemId)?.code ?? null) : null, name: read.substitute.itemId ? (substituteItems.get(read.substitute.itemId)?.name ?? null) : null, note: read.substitute.note } : null
          // W1's kind for the four link answers; a substitute or a change in words reads as its deliveries say (kind OTHER or AS_ASKED) with `substitute` / `needsBuyer`.
          const kind = read.kind === 'SUBSTITUTE' || read.kind === 'CHANGE' ? (read.changes.length === 0 ? 'AS_ASKED' : 'OTHER') : read.kind
          return { kind, portalKind: read.kind, quantity: read.quantity, date: read.date, deliveries: read.deliveries.map((part) => ({ ...part })), reason: read.reason, changes: [...read.changes], substitute, needsBuyer: read.needsBuyer }
        })(),
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
