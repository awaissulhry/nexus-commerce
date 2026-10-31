import { decimalValue, phrase, type BuyingCan, type Loaded, type Phrase } from '../../_shared/buying/model'
import type { OrderReach, OrderReminders, OrderRevision, OrderRevisions, PoLine, PurchaseOrder, ReachAction, SendCard, SendOutcome } from './api'
import { cancelHeld } from './model'

/**
 * Purchasing every day (B-W2a-69, on B-W2a-52's API): the PO's changes after the send, pure — Change → the next revision's
 * draft, counter-propose, cancel lines, close short, the cancel's reach, the confirm-by and the reminders, Send n. Every
 * verb says why it is held, in this app's words (the `purchasing-orders` catalogue); the API's English (reach `problems`,
 * refusal messages) is never drawn: the words come from the facts (status, what came per line) and the codes.
 */

export type DailyCan = Pick<BuyingCan, 'poManage' | 'poSend' | 'cost'>

/** Change (SENT, DECLINED, CONFIRMED → the draft of revision n + 1): purchasing.send (it stops the supplier's links). */
export function changeHeld(order: Pick<PurchaseOrder, 'status'>, can: DailyCan): Phrase | null {
  switch (order.status) {
    case 'SENT':
    case 'DECLINED':
    case 'CONFIRMED':
      return can.poSend ? null : phrase('buying:held.noSend')
    case 'DRAFT':
      return phrase('change.held.draft')
    case 'CHANGES_PROPOSED':
      return phrase('change.held.proposed')
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
      return phrase('change.held.received')
    default:
      return phrase('change.held.closed')
  }
}

/** Counter-propose (the supplier's proposal refused, the order back to a draft of the next revision from what was asked). */
export function counterHeld(order: Pick<PurchaseOrder, 'status'>, can: DailyCan): Phrase | null {
  if (order.status !== 'CHANGES_PROPOSED') return phrase('counter.held.noProposal')
  return can.poSend ? null : phrase('buying:held.noSend')
}

/** A reminder by hand: a sent order still waiting for its answer, purchasing.send, someone to mail. */
export function remindHeld(order: Pick<PurchaseOrder, 'status' | 'contact'>, can: DailyCan): Phrase | null {
  if (order.status !== 'SENT') return phrase('remind.held.notWaiting')
  if (!can.poSend) return phrase('buying:held.noSend')
  if (!order.contact?.email) return phrase('remind.held.noEmail')
  return null
}

/** Move the confirm-by time: a sent order, purchasing.manage (nothing goes out). */
export function confirmByHeld(order: Pick<PurchaseOrder, 'status'>, can: DailyCan): Phrase | null {
  if (order.status !== 'SENT') return phrase('confirmBy.held.notSent')
  return can.poManage ? null : phrase('buying:held.noManage')
}

// ---- lines that end ------------------------------------------------------------------------------------------------------

const received = (line: PoLine) => decimalValue(line.receivedBaseQuantity) ?? 0
const ordered = (line: PoLine) => decimalValue(line.baseQuantity) ?? 0
export const isEnded = (line: Pick<PoLine, 'ended'>): boolean => !!line.ended

/** The ids of the lines a draft of revision 2+ added itself (removed, never cancelled), from the revisions read. */
export function addedInDraft(revisions: OrderRevisions | null): ReadonlySet<string> {
  return new Set((revisions?.draft?.changes.lines ?? []).filter((line) => line.kind === 'ADDED').map((line) => line.lineId))
}

/**
 * Why one line may not be cancelled now (null: it may). A draft of revision 1 removes lines instead; a draft of a later
 * revision cancels the lines an earlier one sent; goods that came → close short instead.
 */
export function cancelLineHeld(order: Pick<PurchaseOrder, 'status' | 'revision'>, line: PoLine, added: ReadonlySet<string>, can: DailyCan): Phrase | null {
  if (!can.poManage) return phrase('buying:held.noManage')
  if (line.ended) return phrase(line.ended.kind === 'CANCELLED' ? 'line.held.cancelled' : 'line.held.closedShort')
  switch (order.status) {
    case 'DRAFT':
      if (order.revision <= 1 || added.has(line.id)) return phrase('line.held.newInDraft')
      break
    case 'SENT':
    case 'DECLINED':
    case 'CONFIRMED':
    case 'PARTLY_RECEIVED':
      if (!can.poSend) return phrase('buying:held.noSend')
      break
    case 'CHANGES_PROPOSED':
      return phrase('line.held.proposed')
    default:
      return phrase('line.held.orderClosed')
  }
  if (received(line) > 0) return phrase('line.held.cameCloseShort')
  return null
}

/** Why one line may not be closed short now (null: it may): part of it came, the rest is still expected. */
export function closeShortHeld(order: Pick<PurchaseOrder, 'status'>, line: PoLine, can: DailyCan): Phrase | null {
  if (!can.poManage) return phrase('buying:held.noManage')
  if (!can.poSend) return phrase('buying:held.noSend')
  if (line.ended) return phrase(line.ended.kind === 'CANCELLED' ? 'line.held.cancelled' : 'line.held.closedShort')
  if (order.status !== 'PARTLY_RECEIVED') return order.status === 'RECEIVED' ? phrase('line.held.allCame') : phrase('line.held.nothingCame')
  if (received(line) <= 0) return phrase('line.held.nothingCameLine')
  if (received(line) >= ordered(line)) return phrase('line.held.allCameLine')
  return null
}

/**
 * The reach read before a cancel or a close short, in words: the API's `allowed` with the reason from the facts (status,
 * what came per line). Never the API's own sentences.
 */
export function reachHeld(order: Pick<PurchaseOrder, 'status' | 'revision' | 'lines'>, action: ReachAction, reach: OrderReach, added: ReadonlySet<string>, can: DailyCan): Phrase | null {
  if (!reach.mayDo) return reach.supplierTold && !can.poSend ? phrase('buying:held.noSend') : phrase('buying:held.noManage')
  if (reach.allowed) return null
  if (action === 'CANCEL_ORDER') {
    const held = cancelHeld({ status: reach.status }, { poManage: true, poSend: true })
    return held ? { ...held, key: `buying:${held.key}` } : phrase('reach.held.other')
  }
  const lines = order.lines.filter((line) => reach.lines.some((entry) => entry.lineId === line.id))
  // A line the action cannot take: the dialog's table says why for each line; the button names the first.
  const lineHeld = lines.find((line) => reachLineHeld(order, action, line, reach.status, added) !== null)
  if (lineHeld) return phrase('reach.held.someLine', { seq: lineHeld.seq })
  if (action === 'CANCEL_LINES') {
    const left = order.lines.filter((line) => !line.ended && !lines.some((picked) => picked.id === line.id))
    if (left.length === 0 && order.lines.every((line) => received(line) === 0)) return phrase('reach.held.lastLines')
  }
  // What the facts here cannot tell (goods at the dock for a line: an open receipt).
  return phrase('reach.held.atDock')
}

/** Why the reach's action cannot take this line (the facts of the order as the reach read it), or null. */
export function reachLineHeld(order: Pick<PurchaseOrder, 'revision'>, action: ReachAction, line: PoLine, status: PurchaseOrder['status'], added: ReadonlySet<string>): Phrase | null {
  const all: DailyCan = { poManage: true, poSend: true, cost: false }
  if (action === 'CLOSE_SHORT') return closeShortHeld({ status }, line, all)
  if (action === 'CANCEL_LINES') return cancelLineHeld({ status, revision: order.revision }, line, added, all)
  return null
}

// ---- revisions -----------------------------------------------------------------------------------------------------------

/** A field of a revision's diff as this app names it (unknown fields: "a detail"). */
export const FIELD_KEYS: Readonly<Record<string, string>> = Object.freeze({
  requestedDate: 'field.requestedDate',
  incoterms: 'field.incoterms',
  paymentTerms: 'field.paymentTerms',
  note: 'field.note',
  quantity: 'field.quantity',
  needDate: 'field.needDate',
  itemColourId: 'field.colour',
  description: 'field.description',
  supplierArticleCode: 'field.articleCode',
  supplierColourCode: 'field.colourCode',
  grade: 'field.grade',
  thicknessMinMm: 'field.thicknessMin',
  thicknessMaxMm: 'field.thicknessMax',
  oneDyeBatch: 'field.oneDyeBatch',
  areaTolerancePct: 'field.tolerance',
})
export const fieldKey = (field: string): string => FIELD_KEYS[field] ?? 'field.other'

/** A quantity value of a diff ("105.0000 FT2") as its number and unit, else null. */
export function quantityValue(value: string | null): { amount: string; uom: string } | null {
  const match = value?.match(/^(-?\d+(?:\.\d+)?)\s+([A-Z0-9_]+)$/)
  return match ? { amount: match[1]!, uom: match[2]! } : null
}

/** The revision answer's pill tone. */
export function answerTone(answer: OrderRevision['answer']): 'success' | 'info' | 'warning' | 'danger' | 'neutral' {
  switch (answer) {
    case 'CONFIRMED':
    case 'RECEIVED':
      return 'success'
    case 'WAITING':
      return 'info'
    case 'CHANGES_PROPOSED':
      return 'warning'
    case 'DECLINED':
    case 'CANCELLED':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** Newest revision first (the list reads like a history). */
export const revisionsNewestFirst = (revisions: readonly OrderRevision[]): OrderRevision[] => [...revisions].sort((a, b) => b.revision - a.revision)

// ---- reminders -----------------------------------------------------------------------------------------------------------

/** Where the deadline stands: none asked, still ahead, passed (the reminders' state in a phrase). */
export function confirmByPhrase(order: Pick<PurchaseOrder, 'status' | 'confirmBy'>, now: Date): Phrase | null {
  if (order.status !== 'SENT' || !order.confirmBy) return null
  return Date.parse(order.confirmBy) <= now.getTime() ? phrase('confirmBy.passed') : phrase('confirmBy.ahead')
}

/** The reminders' summary line: automatic ones off (the Owner's switch) or the next one's time; how many went for this revision. */
export function remindersSummary(reminders: OrderReminders): Phrase {
  if (reminders.status !== 'SENT') return phrase('reminders.notWaiting')
  if (!reminders.automatic) return reminders.overdue ? phrase('reminders.overdueManual') : phrase('reminders.manualOnly')
  return reminders.nextAutomaticAt ? phrase('reminders.nextAutomatic') : phrase('reminders.noMoreAutomatic')
}

// ---- Send n --------------------------------------------------------------------------------------------------------------

/** Send n's cards grouped per supplier (one card per supplier, its orders inside), suppliers by name. */
export function cardsBySupplier(cards: readonly SendCard[], supplierName: (partyId: string | null) => string): { partyId: string | null; name: string; cards: SendCard[] }[] {
  const groups = new Map<string, { partyId: string | null; name: string; cards: SendCard[] }>()
  for (const card of cards) {
    const key = card.partyId ?? `none:${card.id}`
    const group = groups.get(key) ?? { partyId: card.partyId, name: supplierName(card.partyId), cards: [] }
    group.cards.push(card)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Why one card of Send n will not go (null: it goes): its read refused, not a draft, a blocking check, no one to mail. */
export function cardHeld(card: SendCard): Phrase | null {
  if (card.refused) return phrase(card.refused.code === 'not_found' ? 'sendMany.held.gone' : card.refused.code === 'forbidden' ? 'held.noSend' : 'sendMany.held.refused')
  if (card.status !== 'DRAFT') return phrase('sendMany.held.notDraft')
  const blocking = card.checks.find((check) => check.severity === 'BLOCKS')
  if (blocking) return phrase(`buying:po.check.${blocking.code}`)
  if (!card.recipient?.email) return phrase('buying:po.check.NO_CONTACT_EMAIL')
  return null
}

/** The orders Send n sends: the cards that may go, each with its version and the confirm-by chosen (else the default). */
export function sendManyBody(cards: readonly SendCard[], confirmBy: Readonly<Record<string, string>>): { id: string; version: number; confirmBy?: string }[] {
  return cards.filter((card) => cardHeld(card) === null && card.version !== null).map((card) => ({ id: card.id, version: card.version!, ...(confirmBy[card.id] ? { confirmBy: confirmBy[card.id] } : {}) }))
}

/** A refused send of Send n in words, from its code (never the API's message). */
export function outcomeWords(outcome: SendOutcome): Phrase {
  if (outcome.outcome === 'SENT') return phrase('sendMany.sent', { to: outcome.sent?.to ?? '' })
  switch (outcome.refused?.code) {
    case 'conflict':
      return phrase('sendMany.refused.conflict')
    case 'forbidden':
      return phrase('buying:held.noSend')
    case 'not_found':
      return phrase('sendMany.held.gone')
    case 'invalid':
      return phrase('sendMany.refused.invalid')
    default:
      return phrase('sendMany.refused.other')
  }
}

// ---- the record's daily parts ---------------------------------------------------------------------------------------------

/** The new dialogs of the PO studio (B-W2a-69). */
export type DailyDialog =
  | { kind: 'change'; note: string }
  | { kind: 'counter'; note: string }
  | { kind: 'cancelOrder'; reason: string; message: string; reach: Loaded<OrderReach> }
  | { kind: 'endLines'; action: 'CANCEL_LINES' | 'CLOSE_SHORT'; lineIds: string[]; reason: string; message: string; reach: Loaded<OrderReach> }
  | { kind: 'confirmBy'; confirmBy: string }
  | { kind: 'remind'; message: string }

export const isDailyDialog = (dialog: { kind: string } | null): dialog is DailyDialog => !!dialog && ['change', 'counter', 'cancelOrder', 'endLines', 'confirmBy', 'remind'].includes(dialog.kind)

/** The send dialog's own fields of a purchase order (beside the shared ones): the confirm-by time and a later revision's note. */
export interface SendExtra {
  confirmBy: string
  changeNote: string
}
