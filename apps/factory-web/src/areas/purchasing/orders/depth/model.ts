import { lineDifference, type LineDifference } from '@nexus/factory-domain/inventory/receipts/rules'
import { rateProblem } from '@nexus/factory-domain/purchasing/po-depth/currency'
import { MAX_DELIVERIES } from '@nexus/factory-domain/purchasing/po-depth/schedule'
import { Dec, parseDecimal } from '@nexus/factory-domain/tax/decimal'
import { phrase, type Loaded, type Part, type Phrase } from '../../../_shared/buying/model'
import type { PoLine, PoStatus, PurchaseOrder, SendCheck } from '../api'
import type { Blocked, ChasePreview, Compliance, DateSource, Delivery, DepthLine, KindLine, LineKinds, OrderApproval, OrderDemand, OrderDepth, Requirement, SupplierClosures, WorklistRow } from './api'
import { MAX_CHASE_MESSAGE, OVERRIDE_REASON } from './api'

/**
 * B-W2b-333 — purchase orders in depth on screen, the rules without a screen (pure, held by depth.vitest.test.ts): who may
 * do what and why it is held, a delivery schedule's draft and its checks, the supplier's day (first or a move), the rate
 * at order, the lines by kind in words (rolls, certificate, variant), the compliance gate's held marks and the override,
 * the demand each line serves ("what it blocks if late"), the chase, duplicate, the send's approval, the receipts against
 * the tolerance, and what the PO list draws from the expediting worklist. Every phrase is a key of
 * `purchasing-orders-depth` (a `buying:` key is the buying catalogue's).
 */

export const DEPTH = 'purchasing-orders-depth'

// ---- rights -----------------------------------------------------------------------------------------------------------------

export interface DepthCan {
  view: boolean
  manage: boolean
  send: boolean
  cost: boolean
  /** purchasing.compliance.override: say yes or no to a colleague's request to send without a valid document. */
  override: boolean
  /** parties.view: the supplier's closures (its profile). */
  parties: boolean
}

export function depthCanOf(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    view: held.has('purchasing.view'),
    manage: held.has('purchasing.manage'),
    send: held.has('purchasing.send'),
    cost: held.has('money.cost'),
    override: held.has('purchasing.compliance.override'),
    parties: held.has('parties.view'),
  }
}

/** The order states a supplier's day can be recorded in (B-W2b-296: a first day while it waits or is confirmed; a move also once goods came). */
const FIRST_DAY = new Set<PoStatus>(['SENT', 'CHANGES_PROPOSED', 'CONFIRMED'])
const MOVE_DAY = new Set<PoStatus>(['SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'])
/** The states an order is chased in: sent and not yet all received. */
export const CHASE_STATUSES: ReadonlySet<PoStatus> = new Set(['SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'])

// ---- the delivery schedule (SCM-052) ------------------------------------------------------------------------------------

export interface DeliveryDraft {
  quantity: string
  needDate: string
  note: string
}

/** A typed quantity as the API reads it: a comma is a decimal point. */
export const typedDecimal = (text: string): string => text.trim().replace(',', '.')
const plain = (text: string): string => {
  const value = parseDecimal(text)
  return value ? value.toString() : text
}

/** A day `days` after `day` (YYYY-MM-DD). */
export function dayPlus(day: string, days: number): string {
  const at = new Date(`${day}T12:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/**
 * Where the schedule dialog starts: the line's deliveries as they are, or — a line of one delivery — the line split in
 * two, the first on its need date, the second a week later (the buyer changes both).
 */
export function scheduleDraftOf(line: Pick<DepthLine, 'quantity' | 'needDate' | 'deliveries'>): DeliveryDraft[] {
  if (line.deliveries.length > 0) return line.deliveries.map((delivery) => ({ quantity: plain(delivery.quantity), needDate: delivery.needDate, note: delivery.note ?? '' }))
  return splitEvenly(line.quantity, 2, line.needDate, 7)
}

/**
 * The line's quantity in `count` deliveries `everyDays` apart from `firstDay`: each the same share rounded down to four
 * places, the last one takes the rest (so they add up to the line exactly).
 */
export function splitEvenly(quantity: string, count: number, firstDay: string, everyDays: number): DeliveryDraft[] {
  const total = parseDecimal(typedDecimal(quantity))
  const n = Math.max(2, Math.min(MAX_DELIVERIES, Math.floor(count)))
  if (!total || !total.greaterThan(0)) return Array.from({ length: n }, (_, index) => ({ quantity: '', needDate: dayPlus(firstDay, index * everyDays), note: '' }))
  const share = total.dividedBy(n).toDecimalPlaces(4, Dec.ROUND_DOWN)
  return Array.from({ length: n }, (_, index) => ({
    quantity: (index === n - 1 ? total.minus(share.times(n - 1)) : share).toString(),
    needDate: dayPlus(firstDay, index * everyDays),
    note: '',
  }))
}

/** What the deliveries add up to now (null while a quantity is not a number). */
export function scheduleTotal(rows: readonly DeliveryDraft[]): string | null {
  let total = new Dec(0)
  for (const row of rows) {
    const value = parseDecimal(typedDecimal(row.quantity))
    if (!value) return null
    total = total.plus(value)
  }
  return total.toString()
}

/** Why the schedule cannot be saved as typed (the API's own rules, said first here): null when it can. */
export function scheduleHeld(line: Pick<DepthLine, 'quantity'>, rows: readonly DeliveryDraft[], today: string): Phrase | null {
  if (rows.length < 2) return phrase('schedule.held.two')
  if (rows.length > MAX_DELIVERIES) return phrase('schedule.held.many', { count: MAX_DELIVERIES })
  const days = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const value = parseDecimal(typedDecimal(row.quantity))
    if (!value || !value.greaterThan(0) || value.decimalPlaces() > 4) return phrase('schedule.held.quantity', { n: index + 1 })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.needDate)) return phrase('schedule.held.day', { n: index + 1 })
    if (row.needDate < today) return phrase('schedule.held.past', { n: index + 1 })
    if (days.has(row.needDate)) return phrase('schedule.held.sameDay', { n: index + 1 })
    days.add(row.needDate)
    if (row.note.trim().length > 2000) return phrase('schedule.held.note', { n: index + 1 })
  }
  const total = scheduleTotal(rows)
  if (total !== null && !new Dec(total).equals(new Dec(line.quantity))) return phrase('schedule.held.sum', { total, quantity: plain(line.quantity) })
  return null
}

/** The schedule as the API takes it (by day). */
export const scheduleBody = (rows: readonly DeliveryDraft[]) => [...rows].sort((a, b) => (a.needDate < b.needDate ? -1 : a.needDate > b.needDate ? 1 : 0)).map((row) => ({ quantity: typedDecimal(row.quantity), needDate: row.needDate, ...(row.note.trim() ? { note: row.note.trim() } : {}) }))

/** Why a line's schedule cannot change now: a draft only, purchasing.manage, a live line. */
export function scheduleEditHeld(status: PoStatus, line: Pick<DepthLine, 'ended'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('buying:held.noManage')
  if (line.ended) return phrase('schedule.held.ended')
  if (status === 'PENDING_APPROVAL') return phrase('held.waitingForYes')
  if (status !== 'DRAFT') return phrase('schedule.held.sent')
  return null
}

/** A delivery's state: asked (no supplier's day yet), confirmed on the day, or confirmed later than needed. */
export type DeliveryState = 'DRAFT' | 'ASKED' | 'CONFIRMED' | 'LATER'
export function deliveryState(status: PoStatus, row: Pick<Delivery, 'confirmedDate' | 'confirmedLaterBy'>): DeliveryState {
  if (status === 'DRAFT' || status === 'PENDING_APPROVAL') return 'DRAFT'
  if (!row.confirmedDate) return 'ASKED'
  return row.confirmedLaterBy > 0 ? 'LATER' : 'CONFIRMED'
}

/** One row of the Delivery schedule grid: a delivery of a scheduled line, or the line itself (one delivery). */
export interface ScheduleRow {
  id: string
  lineId: string
  lineSeq: number
  itemCode: string
  /** null: the line itself (no schedule). */
  delivery: Delivery | null
  count: number
  seq: number
  quantity: string
  uom: DepthLine['uom']
  needDate: string
  confirmedDate: string | null
  confirmedLaterBy: number
  note: string | null
  ended: boolean
}

export function scheduleRows(depth: OrderDepth): ScheduleRow[] {
  return depth.lines.flatMap((line): ScheduleRow[] =>
    line.deliveries.length === 0
      ? [{ id: line.id, lineId: line.id, lineSeq: line.seq, itemCode: line.itemCode, delivery: null, count: 1, seq: 1, quantity: line.quantity, uom: line.uom, needDate: line.needDate, confirmedDate: line.confirmedDate, confirmedLaterBy: line.confirmedLaterBy, note: null, ended: line.ended }]
      : line.deliveries.map((delivery) => ({ id: delivery.id, lineId: line.id, lineSeq: line.seq, itemCode: line.itemCode, delivery, count: line.deliveries.length, seq: delivery.seq, quantity: delivery.quantity, uom: line.uom, needDate: delivery.needDate, confirmedDate: delivery.confirmedDate, confirmedLaterBy: delivery.confirmedLaterBy, note: delivery.note, ended: line.ended })),
  )
}

/** The supplier's day for this row: its first one (no reason asked) or a move of a confirmed one (a reason). */
export const supplierDateMode = (row: Pick<ScheduleRow, 'confirmedDate'>): 'FIRST' | 'MOVED' => (row.confirmedDate ? 'MOVED' : 'FIRST')

/** Why the supplier's day cannot be recorded for this row now. */
export function supplierDateHeld(status: PoStatus, row: Pick<ScheduleRow, 'confirmedDate' | 'ended'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('buying:held.noManage')
  if (row.ended) return phrase('schedule.held.ended')
  const allowed = supplierDateMode(row) === 'FIRST' ? FIRST_DAY : MOVE_DAY
  if (!allowed.has(status)) return phrase(status === 'DRAFT' || status === 'PENDING_APPROVAL' ? 'date.held.notSent' : 'date.held.closed')
  return null
}

export interface SupplierDateDraft {
  lineId: string
  deliveryId: string | null
  mode: 'FIRST' | 'MOVED'
  /** The day it is now (asked, or the supplier's). */
  from: string
  date: string
  source: DateSource
  reason: string
  contact: string
}

/** Why the supplier's day cannot be saved as typed. */
export function supplierDateDraftHeld(draft: SupplierDateDraft): Phrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return phrase('date.held.day')
  if (draft.mode === 'MOVED') {
    if (draft.date === draft.from) return phrase('date.held.same')
    if (!draft.reason.trim()) return phrase('date.held.reason')
    if (draft.reason.trim().length > 2000) return phrase('date.held.reasonLong')
  }
  if (draft.contact.trim().length > 200) return phrase('date.held.contactLong')
  return null
}

export function supplierDateBody(draft: SupplierDateDraft, version: number) {
  return {
    version,
    ...(draft.deliveryId ? { deliveryId: draft.deliveryId } : {}),
    date: draft.date,
    source: draft.source,
    ...(draft.mode === 'MOVED' ? { reason: draft.reason.trim() } : {}),
    ...(draft.source === 'SUPPLIER' && draft.contact.trim() ? { supplierContactName: draft.contact.trim() } : {}),
  }
}

/** "Confirmed later than needed": the days, or nothing when it is not later. */
export const laterPhrase = (days: number): Phrase | null => (days > 0 ? phrase('later.days', { count: days }) : null)

// ---- the supplier's closures on the mini calendar ---------------------------------------------------------------------------

/** The closed days to shade (YYYY-MM-DD → the closure's name) and the weekly days off, Monday first (true = closed). */
export function closedDays(closures: SupplierClosures | null): { days: Record<string, string>; weekly: boolean[] } {
  const weekly = Array.from({ length: 7 }, (_, index) => !!closures?.weeklyDaysOff.includes(index + 1))
  const days: Record<string, string> = {}
  for (const span of closures?.ahead ?? []) {
    for (let day = span.from; day <= span.to; day = dayPlus(day, 1)) days[day] = span.name
  }
  return { days, weekly }
}

/** A delivery asked on a day the supplier is closed (by its weekly days off or a closure). */
export function onClosedDay(day: string, closed: { days: Record<string, string>; weekly: boolean[] }): boolean {
  if (closed.days[day]) return true
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
  return !!closed.weekly[(weekday + 6) % 7]
}

// ---- the rate at order (SCM-065) --------------------------------------------------------------------------------------------

/** Why the rate cannot be set now: an order in another currency than the company's, a draft, purchasing.manage. */
export function rateEditHeld(order: Pick<PurchaseOrder, 'status'>, depth: Pick<OrderDepth, 'currency'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!depth.currency.takesRate) return phrase('rate.held.sameCurrency')
  if (!can.manage) return phrase('buying:held.noManage')
  if (order.status === 'PENDING_APPROVAL') return phrase('held.waitingForYes')
  if (order.status !== 'DRAFT') return phrase('rate.held.sent')
  return null
}

/** Why the typed rate is not one (a plain decimal above 0, eight places at most). */
export const rateDraftHeld = (rate: string): Phrase | null => (rate.trim() === '' ? phrase('rate.held.empty') : rateProblem(typedDecimal(rate)) ? phrase('rate.held.bad') : null)

// ---- lines by kind (SCM-076, SCM-077, SCM-186) ------------------------------------------------------------------------------

/** The line's kind in words for the Lines grid: rolls (fabric, trim), the certificate (protector), the variant. */
export function kindPhrases(line: KindLine): Phrase[] {
  const out: Phrase[] = []
  if (line.rolls) {
    const { count, lengthM, widthCm } = line.rolls
    out.push(lengthM && widthCm ? phrase('kind.rolls.full', { count, length: plain(lengthM), width: plain(widthCm) }) : lengthM ? phrase('kind.rolls.length', { count, length: plain(lengthM) }) : phrase('kind.rolls.count', { count }))
    if (!line.rolls.matches) out.push(phrase('kind.rolls.notQuantity'))
    if (line.widthNote && line.materialWidthCm) out.push(phrase('kind.rolls.otherWidth', { width: plain(line.materialWidthCm) }))
  }
  if (line.ppe || line.buysAs === 'PROTECTOR') {
    if (line.certificate) {
      out.push(phrase('kind.certificate', { number: line.certificate.number, standard: line.certificate.standard }))
      if (line.certificate.state !== 'HOLDS') out.push(phrase(`kind.certificateState.${line.certificate.state}`))
      else if (line.certificate.endsBeforeNeed) out.push(phrase('kind.certificateEndsEarly', { date: line.certificate.validTo }))
    } else out.push(phrase(line.certificateChoices.length > 0 ? 'kind.noCertificate' : 'kind.noCertificateKnown'))
  }
  if (line.variant) out.push(phrase(line.variant.problem ? 'kind.variantNotUsable' : 'kind.variant', { code: line.variant.code }))
  return out
}

/** Whether the kind's words carry a warning the buyer must act on (drawn in the warning tone). */
export function kindWarns(line: KindLine): boolean {
  return (!!line.rolls && !line.rolls.matches) || ((line.ppe || line.buysAs === 'PROTECTOR') && (!line.certificate || line.certificate.state !== 'HOLDS' || line.certificate.endsBeforeNeed)) || !!line.variant?.problem
}

/** What the kind dialog can set on this line: rolls (fabric and trim), a certificate (a PPE line), a variant (a choice or one set). */
export function kindFields(line: KindLine): { rolls: boolean; certificate: boolean; variant: boolean } {
  return { rolls: line.buysAs === 'FABRIC' || line.buysAs === 'TRIM', certificate: line.ppe || line.buysAs === 'PROTECTOR', variant: line.variantChoices.length > 0 || line.variant !== null }
}

export interface KindDraft {
  lineId: string
  byRolls: boolean
  count: string
  lengthM: string
  widthCm: string
  certificateId: string
  variantCode: string
}

export function kindDraftOf(line: KindLine): KindDraft {
  return {
    lineId: line.id,
    byRolls: !!line.rolls,
    count: line.rolls ? String(line.rolls.count) : '',
    lengthM: line.rolls?.lengthM ? plain(line.rolls.lengthM) : '',
    widthCm: line.rolls?.widthCm ? plain(line.rolls.widthCm) : line.materialWidthCm ? plain(line.materialWidthCm) : '',
    certificateId: line.certificate?.id ?? '',
    variantCode: line.variant?.code ?? '',
  }
}

/** Why the line's kind cannot change now (the API's mayChange: a draft and purchasing.manage). */
export function kindEditHeld(kinds: Pick<LineKinds, 'mayChange' | 'status'>, line: Pick<KindLine, 'ended'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('buying:held.noManage')
  if (line.ended) return phrase('schedule.held.ended')
  if (kinds.status === 'PENDING_APPROVAL') return phrase('held.waitingForYes')
  if (!kinds.mayChange) return phrase('kind.held.sent')
  return null
}

const positive = (text: string, places: number, max: number) => {
  const value = parseDecimal(typedDecimal(text))
  return !!value && value.greaterThan(0) && value.decimalPlaces() <= places && value.lessThanOrEqualTo(max)
}

/** Why the kind dialog cannot save as typed. */
export function kindDraftHeld(line: KindLine, draft: KindDraft): Phrase | null {
  if (kindFields(line).rolls && draft.byRolls) {
    if (!/^\d+$/.test(draft.count.trim()) || Number(draft.count) < 1 || Number(draft.count) > 9999) return phrase('kind.held.count')
    if (draft.lengthM.trim() && !positive(draft.lengthM, 2, 10000)) return phrase('kind.held.length')
    if (draft.widthCm.trim() && !positive(draft.widthCm, 2, 1000)) return phrase('kind.held.width')
  }
  return null
}

/** The body: only what changed (null clears). */
export function kindBody(line: KindLine, draft: KindDraft, version: number) {
  const fields = kindFields(line)
  const before = kindDraftOf(line)
  const rolls = draft.byRolls ? { count: Number(draft.count), lengthM: draft.lengthM.trim() ? typedDecimal(draft.lengthM) : null, widthCm: draft.widthCm.trim() ? typedDecimal(draft.widthCm) : null } : null
  const rollsChanged = draft.byRolls !== before.byRolls || (draft.byRolls && (draft.count !== before.count || draft.lengthM !== before.lengthM || draft.widthCm !== before.widthCm))
  return {
    version,
    ...(fields.rolls && rollsChanged ? { rolls } : {}),
    ...(fields.certificate && draft.certificateId !== before.certificateId ? { certificateId: draft.certificateId || null } : {}),
    ...(fields.variant && draft.variantCode !== before.variantCode ? { variantCode: draft.variantCode || null } : {}),
  }
}

// ---- the compliance gate and the override (SCM-022) ---------------------------------------------------------------------------

/** What holds the order at Send (each with its words). */
export const heldRequirements = (compliance: Compliance | null): Requirement[] => (compliance?.requirements ?? []).filter((requirement) => requirement.severity === 'BLOCKS')

/** A requirement in this app's words: "The chromium VI test report for DEMO-LEA-01 expired on 2 Oct — this PO can't be sent." */
export function requirementPhrase(requirement: Requirement): Phrase {
  const items = requirement.itemCodes.join(', ')
  const lines = requirement.seqs.join(', ')
  return phrase(`mark.${requirement.kind}.${requirement.state}`, { items, lines, date: requirement.expiresOn ?? '' })
}

/** The held mark of one line (its kinds of document), or null when nothing holds it. */
export function lineHeldMark(compliance: Compliance | null, lineId: string): Requirement[] {
  if (!compliance?.lines.some((line) => line.lineId === lineId && line.held)) return []
  return heldRequirements(compliance).filter((requirement) => requirement.lineIds.includes(lineId))
}

/** Why "Send without a valid document…" is held (the API's `may.ask` said in our words). */
export function overrideAskHeld(order: Pick<PurchaseOrder, 'status'>, compliance: Compliance, can: Pick<DepthCan, 'send'>): Phrase | null {
  if (!can.send) return phrase('buying:held.noSend')
  if (order.status !== 'DRAFT') return phrase('override.held.notDraft')
  if (heldRequirements(compliance).length === 0) return phrase('override.held.nothing')
  if (compliance.request?.state === 'WAITING') return phrase('override.held.waiting')
  if (compliance.request?.state === 'APPROVED' && compliance.request.current) return phrase('override.held.approved')
  if (!compliance.may.ask) return phrase('override.held.other')
  return null
}

export function overrideReasonHeld(reason: string): Phrase | null {
  const length = reason.trim().length
  if (length < OVERRIDE_REASON.min) return phrase('override.held.reason', { count: OVERRIDE_REASON.min })
  if (length > OVERRIDE_REASON.max) return phrase('override.held.reasonLong', { count: OVERRIDE_REASON.max })
  return null
}

/** Why the decider's yes or no is held (never the asker, the Owner included; purchasing.compliance.override). */
export function overrideDecideHeld(compliance: Compliance, can: Pick<DepthCan, 'override'>): Phrase | null {
  const request = compliance.request
  if (!request || request.state !== 'WAITING') return phrase('decide.held.none')
  if (request.askedBy.me) return phrase('decide.held.own')
  if (!can.override) return phrase('decide.held.noRight')
  if (!request.current) return phrase('decide.held.stale')
  if (!compliance.may.decide) return phrase('decide.held.other')
  return null
}

/** The request's state in words (who asked or decided is a person inside this one record). */
export function requestPhrase(request: Compliance['request']): Phrase | null {
  if (!request) return null
  const name = request.askedBy.me ? null : request.askedBy.name
  switch (request.state) {
    case 'WAITING':
      return request.current ? phrase(name ? 'request.waitingBy' : 'request.waiting', { name: name ?? '' }) : phrase('request.waitingStale')
    case 'APPROVED':
      return request.current ? phrase('request.approved', { name: request.decidedBy?.name ?? '' }) : phrase('request.approvedStale', { name: request.decidedBy?.name ?? '' })
    case 'REJECTED':
      return phrase('request.rejected', { name: request.decidedBy?.name ?? '' })
    case 'WITHDRAWN':
      return phrase('request.withdrawn')
  }
}

/** The checks the record draws: the order's own (W1 + depth + kinds) and the gate's (the record's `send` leaves the gate out). */
export function allChecks(own: readonly SendCheck[], compliance: Compliance | null): SendCheck[] {
  const seen = new Set(own.map((check) => `${check.code}|${check.path}`))
  return [...own, ...(compliance?.checks ?? []).filter((check) => !seen.has(`${check.code}|${check.path}`))]
}

// ---- the demand each line serves (SCM-064) ------------------------------------------------------------------------------------

export interface LineBlocks {
  workOrders: { id: string; number: string; lateBy: number }[]
  salesOrders: { id: string; number: string; lateBy: number }[]
  /** Demand of no order (safety stock, a reorder point). */
  other: number
  /** The most days this line puts one of them late (0: in time). */
  lateBy: number
}

/** What one line's demands are: the work and customer orders it supplies, each with the days it would be late. */
export function blocksOf(entries: readonly Blocked[]): LineBlocks {
  const work = new Map<string, { id: string; number: string; lateBy: number }>()
  const sales = new Map<string, { id: string; number: string; lateBy: number }>()
  let other = 0
  for (const entry of entries) {
    const target = entry.salesOrder ? { map: sales, id: entry.salesOrder.id, number: entry.salesOrder.number } : entry.workOrder ? { map: work, id: entry.workOrder.id, number: entry.workOrder.number } : null
    if (!target) {
      other += 1
      continue
    }
    const seen = target.map.get(target.id)
    target.map.set(target.id, { id: target.id, number: target.number, lateBy: Math.max(seen?.lateBy ?? 0, entry.lateBy) })
  }
  const byNumber = (a: { number: string }, b: { number: string }) => a.number.localeCompare(b.number, 'en', { numeric: true })
  const workOrders = [...work.values()].sort(byNumber)
  const salesOrders = [...sales.values()].sort(byNumber)
  return { workOrders, salesOrders, other, lateBy: Math.max(0, ...workOrders.map((entry) => entry.lateBy), ...salesOrders.map((entry) => entry.lateBy)) }
}

export function lineBlocks(demand: OrderDemand | null, lineId: string): LineBlocks | null {
  const line = demand?.lines.find((entry) => entry.lineId === lineId)
  return line ? blocksOf(line.demands) : null
}

/** The days a worklist row compares: its next delivery's when that one is confirmed later, else the line's own (null: on the schedule). */
export function laterDays(row: Pick<WorklistRow, 'needDate' | 'confirmedDate' | 'nextDelivery'>): { asked: string; theirs: string | null } {
  const next = row.nextDelivery
  if (!next) return { asked: row.needDate, theirs: row.confirmedDate }
  if (next.confirmedDate && next.confirmedDate > next.needDate) return { asked: next.needDate, theirs: next.confirmedDate }
  return { asked: row.needDate, theirs: null }
}

/** What the PO list knows of the expediting worklist (B-W2b-305): the lines at risk read, the tiles, or why not. */
export type WorklistPart = { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; rows: readonly WorklistRow[]; complete: boolean; confirmedLate: number }

/** "What it blocks" on the PO list: per order, the customer and work orders its late or unconfirmed lines put at risk. */
export function blocksByOrder(rows: readonly WorklistRow[]): Map<string, LineBlocks> {
  const byOrder = new Map<string, Blocked[]>()
  for (const row of rows) byOrder.set(row.purchaseOrderId, [...(byOrder.get(row.purchaseOrderId) ?? []), ...row.blocks.entries.filter((entry) => entry.lateBy > 0)])
  return new Map([...byOrder.entries()].map(([id, entries]) => [id, blocksOf(entries)]))
}

// ---- the chase (SCM-068) -----------------------------------------------------------------------------------------------------

export interface ChaseModel {
  orderId: string
  number: string
  supplier: string
  preview: Loaded<ChasePreview>
  /** The lines chosen (default: every line the preview lists). */
  lineIds: readonly string[] | null
  message: string
  busy: boolean
  problem: Phrase | null
  done: { to: string; at: string } | null
}

/** Why Send chase is held: the right, the order's state, what the preview found, the message's length, offline. */
export function chaseHeld(model: Pick<ChaseModel, 'preview' | 'lineIds' | 'message' | 'busy' | 'done'>, status: PoStatus | null, can: Pick<DepthCan, 'send'>, offline = false): Phrase | null {
  if (model.done) return phrase('chase.held.done')
  if (model.busy) return phrase('buying:held.busy')
  if (!can.send) return phrase('buying:held.noSend')
  if (offline) return phrase('chase.held.offline')
  if (status && !CHASE_STATUSES.has(status)) return phrase(status === 'DRAFT' || status === 'PENDING_APPROVAL' ? 'chase.held.notSent' : 'chase.held.closed')
  if (model.preview.status !== 'ready') return phrase('chase.held.reading')
  const preview = model.preview.value
  if (preview.lines.length === 0) return phrase('chase.held.nothing')
  if (!preview.recipient?.email) return phrase('chase.held.noContact')
  if (!preview.allowed) return phrase('chase.held.other')
  if ((model.lineIds ?? preview.lines.map((line) => line.lineId)).length === 0) return phrase('chase.held.noLine')
  if (model.message.length > MAX_CHASE_MESSAGE) return phrase('chase.held.long', { count: MAX_CHASE_MESSAGE })
  return null
}

/** The row verb and ⋯ entry: chase a sent order (purchasing.send). */
export function chaseVerbHeld(status: PoStatus, can: Pick<DepthCan, 'send'>): Phrase | null {
  if (!CHASE_STATUSES.has(status)) return phrase(status === 'DRAFT' || status === 'PENDING_APPROVAL' ? 'chase.held.notSent' : 'chase.held.closed')
  return can.send ? null : phrase('buying:held.noSend')
}

// ---- duplicate or reorder (SCM-057) ---------------------------------------------------------------------------------------------

export interface DuplicateDraft {
  lineIds: readonly string[]
  needDate: string
}

/** The lines a copy may take: every line not cancelled (a closed-short line may be bought again). */
export const copyableLines = (order: Pick<PurchaseOrder, 'lines'>): PoLine[] => order.lines.filter((line) => line.ended?.kind !== 'CANCELLED')

export function duplicateHeld(can: Pick<DepthCan, 'manage'>): Phrase | null {
  return can.manage ? null : phrase('buying:held.noManage')
}

export function duplicateDraftHeld(draft: DuplicateDraft, today: string): Phrase | null {
  if (draft.lineIds.length === 0) return phrase('duplicate.held.noLine')
  if (draft.needDate && draft.needDate < today) return phrase('duplicate.held.past')
  return null
}

// ---- the send's approval (SCM-078) ----------------------------------------------------------------------------------------------

/** Who a request waits for, in words: a role or a person by name. */
export const approverName = (approver: { name: string } | null): string => approver?.name ?? ''

/** The record's approval line: waiting, approved (sent or not yet), refused, taken back, stale; null when there is nothing to say. */
export function approvalPhrase(approval: OrderApproval | null): { tone: 'warning' | 'success' | 'danger' | 'info'; words: Phrase } | null {
  if (!approval) return null
  const task = approval.task
  switch (approval.state) {
    case 'WAITING':
      return { tone: 'warning', words: phrase(task?.dueAt ? 'approval.waitingDue' : 'approval.waiting', { approver: approverName(task?.approver ?? null), due: task?.dueAt ?? '' }) }
    case 'APPROVED':
      return { tone: 'success', words: phrase(approval.status === 'PENDING_APPROVAL' ? 'approval.approvedSending' : 'approval.approvedDraft', { name: task?.decidedBy?.name ?? '' }) }
    case 'SENT_WITH_YES':
      return { tone: 'info', words: phrase('approval.sentWithYes', { name: task?.decidedBy?.name ?? '' }) }
    case 'REJECTED':
      return { tone: 'danger', words: phrase('approval.rejected', { name: task?.decidedBy?.name ?? '' }) }
    case 'WITHDRAWN':
      return { tone: 'info', words: phrase('approval.withdrawn') }
    case 'STALE':
      return { tone: 'info', words: phrase('approval.stale') }
    default:
      return null
  }
}

/** Take the request back: a waiting order, purchasing.send. */
export function withdrawHeld(approval: OrderApproval | null, can: Pick<DepthCan, 'send'>): Phrase | null {
  if (!approval || approval.state !== 'WAITING') return phrase('approval.held.notWaiting')
  return can.send ? null : phrase('buying:held.noSend')
}

// ---- receipts against the tolerance (SCM-061) ------------------------------------------------------------------------------

export interface ReceiptLine {
  id: string
  seq: number
  item: string
  baseUom: PoLine['baseUom']
  expected: string
  received: string
  /** null: nothing came yet. */
  difference: LineDifference | null
  tolerance: { over: string; under: string; source: 'LINE' | 'RULE' | 'NONE' }
  ended: boolean
}

/** Each line received so far against what it expects, with its tolerance either way (the receipt command's own rule). */
export function receiptLines(order: Pick<PurchaseOrder, 'lines'>, depth: OrderDepth | null): ReceiptLine[] {
  return order.lines.map((line) => {
    const tolerance = depth?.lines.find((entry) => entry.id === line.id)?.tolerance ?? { overPct: line.areaTolerancePct ?? '0', underPct: line.areaTolerancePct ?? '0', source: line.areaTolerancePct ? ('LINE' as const) : ('NONE' as const), whenBeyond: 'REASON' as const, toleranceId: null }
    const received = parseDecimal(line.receivedBaseQuantity) ?? new Dec(0)
    return {
      id: line.id,
      seq: line.seq,
      item: `${line.item.code} · ${line.item.name}`,
      baseUom: line.baseUom,
      expected: line.baseQuantity,
      received: line.receivedBaseQuantity,
      difference: received.greaterThan(0) ? lineDifference({ expected: line.baseQuantity, receivedBefore: line.receivedBaseQuantity, receiving: '0', tolerancePct: tolerance.overPct, underPct: tolerance.underPct }) : null,
      tolerance: { over: plain(tolerance.overPct), under: plain(tolerance.underPct), source: tolerance.source },
      ended: !!line.ended,
    }
  })
}

/** The difference in percent of what was expected ("+4.8", "−1.2"), for the tolerance column. */
export function differencePct(line: Pick<ReceiptLine, 'expected' | 'difference'>): string | null {
  if (!line.difference) return null
  const expected = new Dec(line.expected)
  if (expected.isZero()) return null
  return new Dec(line.difference.difference).times(100).dividedBy(expected).toDecimalPlaces(1).toString()
}

// ---- the send dialog's check list (pop:send#1) ---------------------------------------------------------------------------

/** The codes that mean "documents valid" does not pass (the W2b gate, B-W2b-315; a send on an override's yes is not "valid"). */
export const DOCUMENT_CODES: ReadonlySet<SendCheck['code']> = new Set(['COMPLIANCE_DOCUMENT_MISSING', 'COMPLIANCE_CERTIFICATE_MISSING', 'COMPLIANCE_RULE_MISSING', 'COMPLIANCE_OVERRIDE_WAITING', 'COMPLIANCE_OVERRIDDEN', 'PPE_NO_CERTIFICATE', 'PPE_CERTIFICATE_NOT_VALID'])

/** Where a depth check is fixed: the Delivery schedule tab, the totals' rate, the Lines tab (kinds, documents). */
export function depthFixOf(code: SendCheck['code'], recordHref: string): { tab: 'schedule' | 'lines'; href: string } | null {
  if (code === 'SCHEDULE_NOT_THE_LINE' || code === 'DELIVERY_DATE_PAST') return { tab: 'schedule', href: `${recordHref}?tab=schedule` }
  if (code === 'NO_RATE_AT_ORDER') return { tab: 'lines', href: `${recordHref}?tab=lines&edit=rate` }
  if (code.startsWith('COMPLIANCE_') || code.startsWith('PPE_') || code === 'ROLLS_NOT_THE_QUANTITY' || code === 'VARIANT_NOT_USABLE') return { tab: 'lines', href: `${recordHref}?tab=lines` }
  return null
}

// ---- the record's depth parts ---------------------------------------------------------------------------------------------

export type DepthDialog =
  | { kind: 'schedule'; lineId: string; rows: DeliveryDraft[] }
  | { kind: 'clearSchedule'; lineId: string }
  | { kind: 'supplierDate'; draft: SupplierDateDraft }
  | { kind: 'rate'; rate: string }
  | { kind: 'lineKind'; draft: KindDraft }
  | { kind: 'override'; reason: string }
  | { kind: 'decide'; decision: 'APPROVED' | 'REJECTED'; words: string }
  | { kind: 'withdrawOverride' }
  | { kind: 'withdrawApproval'; note: string }
  | { kind: 'duplicate'; draft: DuplicateDraft }

export interface StepUpState {
  open: boolean
  busy: boolean
  sentence: string
  problem: string | null
}

/** The depth parts of the PO studio: each read on its own (a failed one says so where it is drawn, never as empty). */
export interface OrderDepthModel {
  can: DepthCan
  depth: Part<OrderDepth>
  kinds: Part<LineKinds>
  compliance: Part<Compliance>
  demand: Part<OrderDemand>
  approval: Part<OrderApproval>
  /** null: not read (no parties.view). */
  closures: Part<SupplierClosures> | null
  dialog: DepthDialog | null
  problem: Phrase | null
  busy: boolean
  chase: ChaseModel | null
  stepUp?: StepUpState
  /** Today in the site's calendar (design cases: fixed). */
  today: string
  /** The month the schedule's calendar shows (YYYY-MM). */
  month?: string
}

export interface OrderDepthActions {
  onDialog?: (dialog: DepthDialog | null) => void
  onSaveSchedule?: () => void
  onClearSchedule?: () => void
  onSupplierDate?: () => void
  onRate?: () => void
  onLineKind?: () => void
  onAskOverride?: () => void
  onDecide?: () => void
  onWithdrawOverride?: () => void
  onWithdrawApproval?: () => void
  onDuplicate?: () => void
  onRetry?: () => void
  onMonth?: (month: string) => void
  chase?: ChaseActions
  stepUp?: { onSubmit?: (code: string) => void; onClose?: () => void }
}

export interface ChaseActions {
  onOpen?: () => void
  onClose?: () => void
  onLines?: (lineIds: string[]) => void
  onMessage?: (message: string) => void
  onSend?: () => void
  onRetry?: () => void
}
