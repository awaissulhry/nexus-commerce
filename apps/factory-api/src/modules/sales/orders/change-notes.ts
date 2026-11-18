import { createHash } from 'node:crypto'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import type { ChangeCell } from '@nexus/factory-domain/order-apply/rules'
import { amendmentDiff, type OrderSnapshot } from '@nexus/factory-domain/sales/amendments/amendments'
import {
  floorNoteOf,
  systemLineOf,
  type AskWhat,
  type CellFigure,
  type DoneItem,
  type FloorChange,
  type LineHead,
  type NextItem,
  type NoteLocale,
  type WorkOrderLabel,
  WORKSHOP_CHANGES,
} from '@nexus/factory-domain/sales/orders/change-notes'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { ruleContext } from '../../../platform/notifications/fan-out'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { partyReaders } from '../../../platform/portal/tasks/people'
import { followersOf } from '../../../platform/threads/followers'
import { mayOnThread, wallScopeOf } from '../../../platform/threads/records'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { can } from '@nexus/factory-domain/core/permissions'
import { effectiveSupervisor } from '@nexus/factory-domain/production-brand/supervisor'
import { PRODUCTION_BRAND_MANAGE } from '@nexus/factory-domain/production-brand/permissions'
import { customerDefaultsOf, orderSupervisorsOf } from '../../production/supervisor/resolver'
import { openSubcontractsOf, stillToDoOf, toldSubcontractsOf } from './still-to-do'
import type { Reader } from './store'

/**
 * B-SA-052 / B-SA-053 / B-SA-054 (sales page plan P8, P8', R2, R7, R8, R9; 13-backend B7; 14-change-flow §4.1, §5; review C-6, C-7,
 * WP-1, WP-2, F-3) — "tell everyone on the order", the ONE writer of the system line: the worker handler `sales.orderChangeNotes`.
 *
 * ON (one change = one command of the office or the customer; every event of it names the same correlation):
 *   order_change_request.answered   a request accepted or refused (by Sales or Production)
 *   order_change_request.withdrawn  the customer withdrew it
 *   sales_order.amended             an amendment of the office's own (in an Accept the request speaks)
 *   sales_order.lines_closed        lines closed short or reopened (idem)
 *   sales_order.status_changed      to CANCELLED only (idem)
 *   sales_order.promise_changed     a new promise date (idem; in the office's amendment the amendment speaks)
 *   work_order_change.applied       production applied a work-order change of the order (or left it as is:
 *   work_order_change.declined      "Left as is")
 *   work_order_hold.placed / lifted a pause placed or lifted on one of the order's work orders (in an Accept or an ECO release
 *                                   the request or the ECO speaks)
 *   change_order.changed            an ECO RELEASED for the order's work orders in progress
 * ONE system command per (correlation, order) — idempotency key `<hash of the correlation>:<order>`, input {correlation, order}:
 * the events of one command meet on it, and only the event that SPEAKS for the change writes (the others are silent by the
 * rules above, read from the records of that very instant), so one change is one line, whichever event the worker runs first.
 *
 * WRITES, in that command:
 *   the system line  an office note on the order's thread (author SYSTEM, audience OFFICE, never for the floor) in the company's
 *                    language, with `change { causedById, orderId, stillToDo }` (B-SA-051: the followers' ONE bell item per reader
 *                    and change, never the person who acted); a closing line when the change's last Still to do row closes
 *   floor notes      (B-SA-053) a "For your work" note (forFloor) on each OPEN work order on the floor (RELEASED, IN_PROGRESS,
 *                    ON_HOLD) whose work changes, in its site's first floor language, and `production.floor_note_posted` (the
 *                    tablets of that site re-read My work). Nothing records who or which station saw it (R2)
 *   the workshops    (B-SA-054) `production.floor_note_posted` names what changed; the partner rule (platform/portal/notifications
 *                    rules/production.ts) tells the workshop of each OPEN subcontract order of that work order, "Order changed —
 *                    check quantities", by the subcontract order's own number (a Notification recordType 'SubcontractOrder',
 *                    the one that closes B-SA-050's TELL_WORKSHOP row)
 *   one audit row    on the order: what was written and told (B-SA-056's "Who was told" reads it)
 *
 * THE WALL (Owner rule 2026-11-16; R7): only this order's records are read and named; a work order of several customers (made
 * before the one-customer rule) is "a work order" in every text; the floor note names the customer's CODE only on a work order of
 * that customer alone, never its name, never a person, never a price; the workshop's notice names only its own subcontract order.
 * B-PR-32 already tells the supervisor and the backup of a customer's withdrawal (APPROVAL): the withdrawal's line is written for
 * the thread and its followers, and the bell rule leaves those two out of it (platform/notifications/rules/threads.ts, B-SA-052).
 */

export const ORDER_CHANGE_NOTES_HANDLER = 'sales.orderChangeNotes'
export const ORDER_CHANGE_NOTE_EVENTS = [
  'order_change_request.answered',
  'order_change_request.withdrawn',
  'sales_order.amended',
  'sales_order.lines_closed',
  'sales_order.status_changed',
  'sales_order.promise_changed',
  'work_order_change.applied',
  'work_order_change.declined',
  'work_order_hold.placed',
  'work_order_hold.lifted',
  'change_order.changed',
] as const

/** The work orders the floor works on (a note on a DRAFT would reach nobody; a closed one is done). */
const ON_THE_FLOOR = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

type Envelope = Pick<EventEnvelope, 'eventId' | 'type' | 'payload' | 'correlationId' | 'occurredAt'>

/** Which fact of the change speaks for one order (read from the event, then the records of its instant). */
type Speaker =
  | { readonly kind: 'REQUEST'; readonly requestId: string }
  | { readonly kind: 'AMENDED'; readonly amendmentId: string }
  | { readonly kind: 'LINES'; readonly change: 'CLOSED' | 'REOPENED'; readonly lineIds: readonly string[] }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'PROMISE'; readonly from: string | null; readonly to: string }
  | { readonly kind: 'WORK_ORDER_CHANGE'; readonly changeId: string }
  | { readonly kind: 'HOLD'; readonly holdId: string; readonly placed: boolean }
  | { readonly kind: 'ECO'; readonly changeOrderId: string }

interface Spoken {
  readonly orderId: string
  readonly speaker: Speaker
}

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)))
const sameInstant = (a: Date | null | undefined, b: Date): boolean => a instanceof Date && a.getTime() === b.getTime()

/** The idempotency key of one change of one order (a correlation may hold any safe characters: hashed). */
export const changeNotesKey = (correlationId: string, orderId: string): string => `ocn:${createHash('sha256').update(correlationId).digest('hex').slice(0, 32)}:${orderId}`

/** A request of the order decided (answered or withdrawn) in the command of that instant: then it speaks for the order. */
async function requestDecidedAt(db: Reader, orderId: string, at: Date): Promise<boolean> {
  return (await db.orderChangeRequest.count({ where: { orderId, OR: [{ answeredAt: at }, { withdrawnAt: at }] } })) > 0
}

/** The orders whose own lines a work order makes (a mixed one may make several customers' orders). */
async function ordersOfWorkOrders(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (workOrderIds.length === 0) return out
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: [...workOrderIds] }, salesOrderLineId: { not: null } }, select: { workOrderId: true, salesOrderLineId: true } })
  const lineIds = [...new Set(cells.map((cell) => cell.salesOrderLineId!))]
  const lines = new Map((lineIds.length > 0 ? await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, orderId: true } }) : []).map((line) => [line.id, line.orderId]))
  for (const cell of cells) {
    const orderId = lines.get(cell.salesOrderLineId!)
    if (!orderId) continue
    const list = out.get(cell.workOrderId) ?? []
    if (!list.includes(orderId)) list.push(orderId)
    out.set(cell.workOrderId, list.sort())
  }
  return out
}

/** Which orders an event speaks for (the silent ones of a command left out). */
export async function spokenOf(db: Reader, event: Envelope): Promise<Spoken[]> {
  const at = asDate(event.occurredAt)
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const orderId = typeof payload.orderId === 'string' ? payload.orderId : null
  switch (event.type) {
    case 'order_change_request.answered':
    case 'order_change_request.withdrawn':
      return orderId && typeof payload.requestId === 'string' ? [{ orderId, speaker: { kind: 'REQUEST', requestId: payload.requestId } }] : []
    case 'sales_order.amended':
      if (!orderId || typeof payload.amendmentId !== 'string' || (await requestDecidedAt(db, orderId, at))) return []
      return [{ orderId, speaker: { kind: 'AMENDED', amendmentId: payload.amendmentId } }]
    case 'sales_order.lines_closed': {
      if (!orderId || (await requestDecidedAt(db, orderId, at))) return []
      const lineIds = Array.isArray(payload.lineIds) ? (payload.lineIds as string[]) : []
      // Closed lines in an office amendment's command: the amendment speaks.
      if ((await db.salesOrderAmendment.count({ where: { orderId, requestId: event.correlationId } })) > 0) return []
      return [{ orderId, speaker: { kind: 'LINES', change: payload.change === 'REOPENED' ? 'REOPENED' : 'CLOSED', lineIds } }]
    }
    case 'sales_order.status_changed':
      if (!orderId || payload.to !== 'CANCELLED' || (await requestDecidedAt(db, orderId, at))) return []
      return [{ orderId, speaker: { kind: 'CANCELLED' } }]
    case 'sales_order.promise_changed':
      if (!orderId || typeof payload.promiseDate !== 'string' || (await requestDecidedAt(db, orderId, at))) return []
      if ((await db.salesOrderAmendment.count({ where: { orderId, requestId: event.correlationId } })) > 0) return []
      return [{ orderId, speaker: { kind: 'PROMISE', from: typeof payload.previous === 'string' ? payload.previous : null, to: payload.promiseDate } }]
    case 'work_order_change.applied':
    case 'work_order_change.declined': {
      const changeId = typeof payload.changeId === 'string' ? payload.changeId : null
      const salesOrderId = typeof payload.salesOrderId === 'string' ? payload.salesOrderId : null
      if (!changeId || !salesOrderId) return []
      // The change by its own row: it is of the order the event names.
      const row = await db.workOrderChange.findUnique({ where: { id: changeId }, select: { salesOrderId: true } })
      return row && row.salesOrderId === salesOrderId ? [{ orderId: salesOrderId, speaker: { kind: 'WORK_ORDER_CHANGE', changeId } }] : []
    }
    case 'work_order_hold.placed':
    case 'work_order_hold.lifted': {
      const holdId = typeof payload.holdId === 'string' ? payload.holdId : null
      const workOrderId = typeof payload.workOrderId === 'string' ? payload.workOrderId : null
      if (!holdId || !workOrderId) return []
      const hold = await db.workOrderHold.findUnique({ where: { id: holdId }, select: { workOrderId: true, requestId: true } })
      if (!hold || hold.workOrderId !== workOrderId) return []
      // An ECO's release of that instant that names the work order speaks for it.
      const eco = await db.changeOrderItem.count({ where: { workOrderId, kind: 'WORK_IN_PROGRESS', changeOrder: { is: { status: 'RELEASED', releasedAt: at } } } })
      if (eco > 0) return []
      const orders = (await ordersOfWorkOrders(db, [workOrderId])).get(workOrderId) ?? []
      const out: Spoken[] = []
      for (const id of orders) if (!(await requestDecidedAt(db, id, at))) out.push({ orderId: id, speaker: { kind: 'HOLD', holdId, placed: event.type === 'work_order_hold.placed' } })
      return out
    }
    case 'change_order.changed': {
      const changeOrderId = typeof payload.changeOrderId === 'string' ? payload.changeOrderId : null
      if (!changeOrderId || payload.status !== 'RELEASED' || payload.change !== 'RELEASED') return []
      const items = await db.changeOrderItem.findMany({ where: { changeOrderId, kind: 'WORK_IN_PROGRESS', workOrderId: { not: null } }, select: { workOrderId: true } })
      const byWorkOrder = await ordersOfWorkOrders(db, [...new Set(items.map((item) => item.workOrderId!))])
      const orders = [...new Set([...byWorkOrder.values()].flat())].sort()
      return orders.map((id) => ({ orderId: id, speaker: { kind: 'ECO', changeOrderId } }))
    }
    default:
      return []
  }
}

// ---- the facts of one change of one order ------------------------------------------------------------------------------------

interface OrderFacts {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId: string
  readonly status: string
  readonly reapprovalNeededAt: Date | null
  readonly customer: string
  readonly customerCode: string
  readonly locale: NoteLocale
  readonly timeZone: string
}

interface WorkOrderFacts {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly partyId: string | null
  readonly companyId: string
  readonly siteId: string
  readonly styleId: string
  readonly styleRevisionId: string | null
}

interface CellFacts {
  readonly id: string
  readonly workOrderId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly quantity: number
  readonly colourwayId: string
}

const localeOf = (value: string | null | undefined): NoteLocale => (value === 'en' ? 'en' : 'it')

async function orderFactsOf(db: Reader, orderId: string): Promise<OrderFacts | null> {
  const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, reapprovalNeededAt: true } })
  if (!order) return null
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { code: true, legalName: true, tradeName: true } })
  const company = await db.company.findUnique({ where: { id: order.companyId }, select: { locale: true, timezone: true } })
  return { ...order, customer: party ? (party.tradeName ?? party.legalName) : '', customerCode: party?.code ?? '', locale: localeOf(company?.locale), timeZone: company?.timezone ?? 'Europe/Rome' }
}

/** A work order as the order's texts name it: its number only when it is of this order's own customer (R7). */
const labelOf = (order: Pick<OrderFacts, 'partyId'>, workOrder: Pick<WorkOrderFacts, 'number' | 'partyId'> | null | undefined): WorkOrderLabel => ({ number: workOrder && workOrder.partyId === order.partyId ? workOrder.number : null })

async function nameOf(db: Reader, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const user = await db.user.findUnique({ where: { id: userId }, select: { displayName: true, audience: true } })
  return user && user.audience === 'OFFICE' ? user.displayName : null
}

/** The office person who acted (null: the customer, the system, or no office person). */
async function officePerson(db: Reader, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const user = await db.user.findUnique({ where: { id: userId }, select: { audience: true } })
  return user?.audience === 'OFFICE' ? userId : null
}

/** Who made a change of the order whose record keeps no "by": the command's own audit row on the order. */
async function auditActorOf(db: Reader, orderId: string, correlationId: string, at: Date): Promise<string | null> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'SalesOrder', recordId: orderId, requestId: correlationId, at }, select: { actorId: true, audience: true } })
  return row && row.audience === 'OFFICE' ? row.actorId : null
}

/** Each size's pieces of a line in one colourway (an amendment's snapshot): the figures a work order's cells make. */
function wanted(snapshot: OrderSnapshot | null, lineId: string, colourwayId: string): Map<string, number> {
  const line = snapshot?.lines.find((entry) => entry.id === lineId)
  if (!line || line.colourwayId !== colourwayId) return new Map()
  return new Map(line.sizes.map((size) => [size.size, size.quantity]))
}

/** The changed figures of one work order's cells, old → new, by an amendment (sizes, a colourway moved: its old cells go to 0). */
function cellFiguresOf(cells: readonly CellFacts[], before: OrderSnapshot | null, after: OrderSnapshot | null): CellFigure[] {
  const out: CellFigure[] = []
  for (const cell of cells) {
    const from = wanted(before, cell.salesOrderLineId, cell.colourwayId).get(cell.size) ?? cell.quantity
    const to = wanted(after, cell.salesOrderLineId, cell.colourwayId).get(cell.size) ?? 0
    if (from !== to) out.push({ size: cell.size, from, to })
  }
  return out
}

/** What is already cut of each cell (the database's own floor, factory_work_order_cell_floor). */
async function cutOf(tx: CommandTx, tenantId: string, cellIds: readonly string[]): Promise<Map<string, number>> {
  if (cellIds.length === 0) return new Map()
  const rows = await tx.$queryRaw<{ id: string; floor: number }[]>`SELECT c.id::text AS id, "factory_work_order_cell_floor"(${tenantId}::uuid, c.id) AS floor FROM unnest(${[...cellIds]}::uuid[]) AS c(id)`
  return new Map(rows.map((row) => [row.id, Number(row.floor)]))
}

/** One work order's floor note being made. */
interface NoteDraft {
  readonly workOrder: WorkOrderFacts
  readonly changes: FloorChange[]
}

function addFloor(drafts: Map<string, NoteDraft>, workOrder: WorkOrderFacts | undefined, change: FloorChange): void {
  if (!workOrder || !(ON_THE_FLOOR as readonly string[]).includes(workOrder.status)) return
  const draft = drafts.get(workOrder.id) ?? { workOrder, changes: [] }
  draft.changes.push(change)
  drafts.set(workOrder.id, draft)
}

interface Composed {
  readonly head: LineHead
  readonly causedById: string | null
  readonly asked: { readonly customer: string; readonly at: Date; readonly what: AskWhat } | null
  readonly answer: string | null
  readonly done: DoneItem[]
  readonly next: NextItem[]
  readonly floor: Map<string, NoteDraft>
  /** The time of the change a closing step ends (a work-order change's Accept, a design change's answer); null: none. */
  readonly closes: Date | null
  /** The request it is about (B-SA-050's TELL_WORKSHOP rows of it). */
  readonly requestId: string | null
}

const seqsOf = (lines: ReadonlyMap<string, number>, ids: readonly string[]): number[] => [...new Set(ids.flatMap((id) => (lines.has(id) ? [lines.get(id)!] : [])))].sort((a, b) => a - b)

/** Everything the speaker's change did to the order, its next steps and its floor notes (read in the command). */
async function compose(tools: CommandTools, tenantId: string, order: OrderFacts, speaker: Speaker, correlationId: string, at: Date): Promise<Composed | null> {
  const { tx } = tools
  const lineRows = await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true } })
  const seqOf = new Map(lineRows.map((line) => [line.id, line.seq]))
  const cells: CellFacts[] = (lineRows.length > 0 ? await tx.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineRows.map((line) => line.id) } }, select: { id: true, workOrderId: true, salesOrderLineId: true, size: true, quantity: true, colourwayId: true } }) : []).map((cell) => ({ ...cell, salesOrderLineId: cell.salesOrderLineId! }))
  const workOrderIds = [...new Set(cells.map((cell) => cell.workOrderId))]
  const workOrders = new Map((workOrderIds.length > 0 ? await tx.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, partyId: true, companyId: true, siteId: true, styleId: true, styleRevisionId: true } }) : []).map((row) => [row.id, row]))
  const cellsOfLines = (lineIds: readonly string[]) => cells.filter((cell) => lineIds.includes(cell.salesOrderLineId))
  const byWorkOrder = (list: readonly CellFacts[]) => {
    const out = new Map<string, CellFacts[]>()
    for (const cell of list) out.set(cell.workOrderId, [...(out.get(cell.workOrderId) ?? []), cell])
    return out
  }
  const floor = new Map<string, NoteDraft>()
  const done: DoneItem[] = []
  const next: NextItem[] = []
  let closes: Date | null = null

  // The amendment of this command (a request's, or the office's own).
  const amendmentFloor = async (amendment: { before: unknown; after: unknown; revision: number }) => {
    const before = amendment.before as unknown as OrderSnapshot
    const after = amendment.after as unknown as OrderSnapshot
    const diff = amendmentDiff(before, after)
    const changed = diff.lines.map((line) => line.lineId)
    const lines = diff.lines.flatMap((line) => (line.sizes.length > 0 ? [{ seq: line.seq, cells: line.sizes.map((size) => ({ size: size.size, from: size.before, to: size.after })) }] : []))
    const touched = byWorkOrder(cellsOfLines(changed))
    const cut = await cutOf(tx, tenantId, [...touched.values()].flat().map((cell) => cell.id))
    for (const [workOrderId, list] of touched) {
      const figures = cellFiguresOf(list, before, after)
      if (figures.length === 0) continue
      const waitSizes = [...new Set(list.filter((cell) => (cut.get(cell.id) ?? 0) === 0 && figures.some((figure) => figure.size === cell.size)).map((cell) => cell.size))]
      addFloor(floor, workOrders.get(workOrderId), { kind: 'SIZES', cells: figures, waitSizes })
    }
    return lines
  }
  const linesClosedFloor = (lineIds: readonly string[]) => {
    for (const [workOrderId, list] of byWorkOrder(cellsOfLines(lineIds))) addFloor(floor, workOrders.get(workOrderId), { kind: 'LINES_CLOSED', seqs: seqsOf(seqOf, list.map((cell) => cell.salesOrderLineId)) })
  }
  // The holds of this instant on the order's work orders (a request's pause or resume, an ECO's hold).
  const holdsAt = async (placed: boolean, requestId?: string) =>
    workOrderIds.length === 0
      ? []
      : tx.workOrderHold.findMany({ where: { workOrderId: { in: workOrderIds }, ...(placed ? { placedAt: at } : { liftedAt: at }), ...(requestId ? { requestId } : {}) }, select: { workOrderId: true } })
  // The work-order changes this command proposed for the order (Still to do: "sent to planning").
  const proposed = async () => {
    const rows = await tx.workOrderChange.findMany({ where: { salesOrderId: order.id, createdAt: at, status: 'PROPOSED' }, select: { workOrderId: true }, orderBy: { id: 'asc' } })
    for (const row of rows) next.push(row.workOrderId ? { kind: 'WORK_ORDER', workOrder: labelOf(order, workOrders.get(row.workOrderId) ?? (await tx.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true, partyId: true } }))) } : { kind: 'NEW_WORK_ORDER' })
  }

  switch (speaker.kind) {
    case 'REQUEST': {
      const request = await tx.orderChangeRequest.findUnique({
        where: { id: speaker.requestId },
        select: { id: true, orderId: true, kind: true, status: true, answer: true, answeredAt: true, answeredById: true, withdrawnAt: true, amendmentId: true, requestedDate: true, shipToAddressId: true, createdAt: true, lines: { select: { orderLineId: true, size: true, quantityBefore: true, quantity: true, colourwayId: true } } },
      })
      // The request by its own row, of this order, decided at this instant.
      if (!request || request.orderId !== order.id) return null
      const kind = String(request.kind)
      const asked = { customer: order.customer, at: request.createdAt, what: askWhatOf(kind, request, seqOf) }
      if (request.status === 'WITHDRAWN' && sameInstant(request.withdrawnAt, at)) {
        return { head: { kind: 'WITHDRAWN', customer: order.customer }, causedById: null, asked, answer: null, done, next, floor, closes, requestId: request.id }
      }
      if (!sameInstant(request.answeredAt, at)) return null
      const by = await nameOf(tx, request.answeredById)
      const causedById = await officePerson(tx, request.answeredById)
      if (request.status === 'REFUSED') return { head: { kind: 'REFUSED', by }, causedById, asked, answer: request.answer, done, next, floor, closes, requestId: request.id }
      if (request.status !== 'ACCEPTED') return null
      const amendment = await tx.salesOrderAmendment.findFirst({ where: { orderId: order.id, OR: [{ requestId: correlationId }, ...(request.amendmentId ? [{ id: request.amendmentId }] : [])] }, select: { revision: true, before: true, after: true } })
      if (amendment) {
        done.push({ kind: 'AMENDED', revision: amendment.revision })
        await amendmentFloor(amendment)
      }
      const closed = lineRows.length > 0 ? await tx.salesOrderLine.findMany({ where: { orderId: order.id, closedShortAt: at }, select: { id: true } }) : []
      if (order.status === 'CANCELLED' && kind === 'CANCEL' && request.lines.length === 0) {
        done.push({ kind: 'CANCELLED' })
        linesClosedFloor(lineRows.map((line) => line.id))
      } else if (closed.length > 0) {
        done.push({ kind: 'LINES_CLOSED', seqs: seqsOf(seqOf, closed.map((line) => line.id)) })
        linesClosedFloor(closed.map((line) => line.id))
      }
      const paused = await holdsAt(true, request.id)
      if (paused.length > 0) {
        done.push({ kind: 'PAUSED', workOrders: paused.map((hold) => labelOf(order, workOrders.get(hold.workOrderId))) })
        for (const hold of paused) addFloor(floor, workOrders.get(hold.workOrderId), { kind: 'PAUSED' })
      }
      const resumed = kind === 'RESUME' ? await holdsAt(false) : []
      if (resumed.length > 0) {
        done.push({ kind: 'RESUMED', workOrders: resumed.map((hold) => labelOf(order, workOrders.get(hold.workOrderId))) })
        for (const hold of resumed) addFloor(floor, workOrders.get(hold.workOrderId), { kind: 'RESUMED' })
      }
      if (kind === 'RUSH') for (const workOrder of workOrders.values()) addFloor(floor, workOrder, { kind: 'RUSH' })
      if (kind === 'DESIGN') {
        // The product change requests the accepted design change raised (B-SA-047), one per style; the floor keeps to its revision.
        const raised = await tx.changeRequest.findMany({ where: { orderChangeRequestId: request.id }, select: { number: true, styleId: true }, orderBy: { number: 'asc' } })
        for (const row of raised) if (row.number) next.push({ kind: 'STYLE', number: row.number })
        const lineIds = request.lines.map((line) => line.orderLineId)
        const revisions = new Map((await tx.styleRevision.findMany({ where: { id: { in: [...workOrders.values()].flatMap((row) => (row.styleRevisionId ? [row.styleRevisionId] : [])) } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision]))
        for (const workOrderId of byWorkOrder(cellsOfLines(lineIds)).keys()) {
          const workOrder = workOrders.get(workOrderId)
          if (!workOrder) continue
          const changeRequest = raised.find((row) => row.styleId === workOrder.styleId)?.number ?? null
          addFloor(floor, workOrder, { kind: 'DESIGN', changeRequest, revision: workOrder.styleRevisionId ? (revisions.get(workOrder.styleRevisionId) ?? null) : null })
        }
      }
      await proposed()
      return { head: { kind: 'ACCEPTED', by }, causedById, asked, answer: null, done, next, floor, closes, requestId: request.id }
    }
    case 'AMENDED': {
      const amendment = await tx.salesOrderAmendment.findUnique({ where: { id: speaker.amendmentId }, select: { orderId: true, revision: true, before: true, after: true, createdById: true } })
      if (!amendment || amendment.orderId !== order.id) return null
      done.push({ kind: 'AMENDED', revision: amendment.revision })
      const lines = await amendmentFloor(amendment)
      if (lines.length > 0) done.push({ kind: 'SIZES', lines })
      const closed = await tx.salesOrderLine.findMany({ where: { orderId: order.id, closedShortAt: at }, select: { id: true } })
      if (closed.length > 0) {
        done.push({ kind: 'LINES_CLOSED', seqs: seqsOf(seqOf, closed.map((line) => line.id)) })
        linesClosedFloor(closed.map((line) => line.id))
      }
      await proposed()
      return { head: { kind: 'CHANGED', by: await nameOf(tx, amendment.createdById) }, causedById: await officePerson(tx, amendment.createdById), asked: null, answer: null, done, next, floor, closes, requestId: null }
    }
    case 'LINES': {
      const seqs = seqsOf(seqOf, speaker.lineIds)
      if (seqs.length === 0) return null
      done.push(speaker.change === 'CLOSED' ? { kind: 'LINES_CLOSED', seqs } : { kind: 'LINES_REOPENED', seqs })
      if (speaker.change === 'CLOSED') linesClosedFloor(speaker.lineIds)
      await proposed()
      const actor = await auditActorOf(tx, order.id, correlationId, at)
      return { head: { kind: 'CHANGED', by: await nameOf(tx, actor) }, causedById: actor, asked: null, answer: null, done, next, floor, closes, requestId: null }
    }
    case 'CANCELLED': {
      done.push({ kind: 'CANCELLED' })
      linesClosedFloor(lineRows.map((line) => line.id))
      await proposed()
      const actor = await auditActorOf(tx, order.id, correlationId, at)
      return { head: { kind: 'CHANGED', by: await nameOf(tx, actor) }, causedById: actor, asked: null, answer: null, done, next, floor, closes, requestId: null }
    }
    case 'PROMISE': {
      done.push({ kind: 'PROMISE', from: speaker.from, to: speaker.to })
      const actor = await auditActorOf(tx, order.id, correlationId, at)
      return { head: { kind: 'CHANGED', by: await nameOf(tx, actor) }, causedById: actor, asked: null, answer: null, done, next, floor, closes, requestId: null }
    }
    case 'WORK_ORDER_CHANGE': {
      const change = await tx.workOrderChange.findUnique({ where: { id: speaker.changeId }, select: { salesOrderId: true, workOrderId: true, kind: true, status: true, cells: true, decidedAt: true, decidedById: true, decisionNote: true, madeWorkOrderId: true, createdAt: true, requestId: true, /* B-SA-053b */ extraOutcome: true } })
      if (!change || change.salesOrderId !== order.id || !sameInstant(change.decidedAt, at)) return null
      const workOrder = change.workOrderId ? (workOrders.get(change.workOrderId) ?? (await tx.workOrder.findUnique({ where: { id: change.workOrderId }, select: { id: true, number: true, status: true, partyId: true, companyId: true, siteId: true, styleId: true, styleRevisionId: true } }))) : null
      // ---- B-SA-053b (14-change-flow S7 "WO-0142 changed: cut 36 M, 24 L"): the work order's OWN cells after the apply, read from
      // its cells now — never the change's target: Lower to the order keeps what is cut (52 asked 4 → 1, 3 cut: the cell makes 3).
      // The pieces it keeps beyond the order's new figure are the extra pieces, named with their outcome in the office line only.
      const changeRows = Array.isArray(change.cells) ? (change.cells as unknown as ChangeCell[]) : []
      const makes = (cell: ChangeCell): number => {
        const own = cell.workOrderSizeId ? cells.find((entry) => entry.id === cell.workOrderSizeId) : undefined
        if (own) return own.quantity
        // A cell the apply took away (lowered to 0) is gone; a cell not read (a MAKE_MORE one not made here): its target.
        return cell.workOrderSizeId && cell.to === 0 ? 0 : cell.to
      }
      const changeCells = changeRows.map((cell) => ({ size: cell.size, from: cell.from, to: change.status === 'APPLIED' ? makes(cell) : cell.to }))
      const extraCount = change.status === 'APPLIED' ? changeRows.reduce((sum, cell) => sum + Math.max(0, makes(cell) - cell.to), 0) : 0
      const extra = extraCount > 0 ? { count: extraCount, outcome: (change.extraOutcome as 'CHARGE' | 'LEFTOVER' | 'SCRAP' | null) ?? null } : null
      // ---- end B-SA-053b
      if (change.status === 'APPLIED') {
        if (workOrder) {
          done.push({ kind: 'WORK_ORDER_CHANGED', workOrder: labelOf(order, workOrder), cells: changeCells, extra })
          addFloor(floor, workOrder ?? undefined, { kind: 'APPLIED', cells: changeCells.map((cell) => ({ size: cell.size, quantity: cell.to })) })
        } else if (change.madeWorkOrderId) {
          const made = await tx.workOrder.findUnique({ where: { id: change.madeWorkOrderId }, select: { number: true, partyId: true } })
          done.push({ kind: 'WORK_ORDER_NEW', workOrder: labelOf(order, made) })
        }
      } else if (change.status === 'DECLINED') {
        done.push({ kind: 'LEFT_AS_IS', workOrder: labelOf(order, workOrder), why: change.decisionNote })
        addFloor(floor, workOrder ?? undefined, { kind: 'LEFT_AS_IS' })
      } else return null
      closes = change.createdAt
      return { head: { kind: 'WORK_ORDER', by: await nameOf(tx, change.decidedById) }, causedById: await officePerson(tx, change.decidedById), asked: null, answer: null, done, next, floor, closes, requestId: change.requestId }
    }
    case 'HOLD': {
      const hold = await tx.workOrderHold.findUnique({ where: { id: speaker.holdId }, select: { workOrderId: true, placedAt: true, placedById: true, liftedAt: true, liftedById: true } })
      if (!hold || !sameInstant(speaker.placed ? hold.placedAt : hold.liftedAt, at)) return null
      const workOrder = workOrders.get(hold.workOrderId)
      if (!workOrder) return null
      done.push(speaker.placed ? { kind: 'PAUSED', workOrders: [labelOf(order, workOrder)] } : { kind: 'RESUMED', workOrders: [labelOf(order, workOrder)] })
      // A mixed work order's note is written once: with the first of its orders (each order still gets its own line).
      const first = ((await ordersOfWorkOrders(tx, [workOrder.id])).get(workOrder.id) ?? [])[0]
      if (first === order.id) addFloor(floor, workOrder, { kind: speaker.placed ? 'PAUSED' : 'RESUMED' })
      const by = speaker.placed ? hold.placedById : hold.liftedById
      return { head: { kind: 'CHANGED', by: await nameOf(tx, by) }, causedById: await officePerson(tx, by), asked: null, answer: null, done, next, floor, closes, requestId: null }
    }
    case 'ECO': {
      const eco = await tx.changeOrder.findUnique({ where: { id: speaker.changeOrderId }, select: { number: true, status: true, releasedAt: true, releasedById: true } })
      if (!eco || eco.status !== 'RELEASED' || !sameInstant(eco.releasedAt, at)) return null
      const items = await tx.changeOrderItem.findMany({ where: { changeOrderId: speaker.changeOrderId, kind: 'WORK_IN_PROGRESS', workOrderId: { in: workOrderIds } }, select: { workOrderId: true } })
      const own = [...new Set(items.map((item) => item.workOrderId!))]
      if (own.length === 0) return null
      done.push({ kind: 'RELEASED', changeOrder: eco.number, workOrders: own.map((id) => labelOf(order, workOrders.get(id))) })
      const held = new Set((await holdsAt(true)).map((hold) => hold.workOrderId))
      const firstOf = await ordersOfWorkOrders(tx, own)
      for (const id of own) if (held.has(id) && (firstOf.get(id) ?? [])[0] === order.id) addFloor(floor, workOrders.get(id), { kind: 'PAUSED' })
      // The design change it carries out, when one of this order's requests raised its change request.
      const answered = await tx.orderChangeRequest.findFirst({ where: { orderId: order.id, kind: 'DESIGN', status: 'ACCEPTED', productChangeRequests: { some: { changeOrderId: speaker.changeOrderId } } }, select: { answeredAt: true } })
      closes = answered?.answeredAt ?? null
      return { head: { kind: 'CHANGED', by: await nameOf(tx, eco.releasedById) }, causedById: await officePerson(tx, eco.releasedById), asked: null, answer: null, done, next, floor, closes, requestId: null }
    }
  }
}

/** What the customer asked, in the request's own terms (its lines by their order's seq; no price). */
function askWhatOf(kind: string, request: { readonly requestedDate: Date | null; readonly shipToAddressId: string | null; readonly lines: readonly { readonly orderLineId: string; readonly size: string | null; readonly quantityBefore: number; readonly quantity: number; readonly colourwayId: string | null }[] }, seqOf: ReadonlyMap<string, number>): AskWhat {
  const seqs = seqsOf(seqOf, request.lines.map((line) => line.orderLineId))
  switch (kind) {
    case 'CANCEL':
      return { kind: 'CANCEL', seqs: request.lines.length > 0 ? seqs : null }
    case 'DESIGN':
      return { kind: 'DESIGN', seqs }
    case 'RUSH':
    case 'HOLD':
    case 'RESUME':
    case 'SPLIT_SHIPMENT':
    case 'SAMPLE_ROUND':
      return { kind }
    default: {
      const sized = request.lines.filter((line) => line.size !== null && line.quantity !== line.quantityBefore)
      if (sized.length > 0) {
        const bySeq = new Map<number, CellFigure[]>()
        for (const line of sized) {
          const seq = seqOf.get(line.orderLineId)
          if (seq === undefined) continue
          bySeq.set(seq, [...(bySeq.get(seq) ?? []), { size: line.size!, from: line.quantityBefore, to: line.quantity }])
        }
        return { kind: 'SIZES', lines: [...bySeq.entries()].sort(([a], [b]) => a - b).map(([seq, cells]) => ({ seq, cells })) }
      }
      if (request.lines.some((line) => line.colourwayId !== null)) return { kind: 'COLOURWAY', seqs }
      if (request.requestedDate) return { kind: 'DATE', date: request.requestedDate.toISOString().slice(0, 10) }
      if (request.shipToAddressId) return { kind: 'ADDRESS' }
      return { kind: 'SIZES', lines: [] }
    }
  }
}

// ---- who is told (the bell's own rule, read at the write: B-SA-051's followers) ---------------------------------------------------

/** The office people the bell will tell of this change: the followers of the order and of each noted work order (muted ones are not followers), never the person who acted, only while they read the record by their live roles. */
async function toldPeople(tools: CommandTools, tenantId: string, records: readonly { readonly type: string; readonly id: string; readonly thread: { readonly recordType: string; readonly recordId: string; readonly companyId: string | null; readonly siteId: string | null; readonly partyId: string | null } }[], causedById: string | null, skip: ReadonlySet<string>): Promise<string[]> {
  const context = ruleContext(tools.tx, tenantId, tools.now)
  const told = new Set<string>()
  for (const record of records) {
    const scope = await wallScopeOf(tools.tx, record.thread)
    for (const userId of await followersOf(tools.tx, { type: record.type, id: record.id })) {
      if (userId === causedById || skip.has(userId) || told.has(userId)) continue
      const reader = await context.reader(userId)
      if (reader && mayOnThread(reader.actor, THREADS_READ, record.type, scope)) told.add(userId)
    }
  }
  return [...told].sort()
}

/**
 * Who B-PR-32 (platform/notifications/rules/brand-production.ts audienceOf) tells of the customer's withdrawal on this order: its
 * supervisor (its own, else the customer's default) and the customer's backup who read the order; when neither may be told, the
 * holders of production.brand.manage over the order's company and customer who read it. The same rule, read at the write.
 */
async function withdrawalToldOf(tools: CommandTools, tenantId: string, order: Pick<OrderFacts, 'id' | 'companyId' | 'partyId'>): Promise<string[]> {
  const context = ruleContext(tools.tx, tenantId, tools.now)
  const place = { companyId: order.companyId, siteId: null, partyId: order.partyId }
  const reads = (actor: Parameters<typeof mayOnThread>[0]) => mayOnThread(actor, THREADS_READ, 'SalesOrder', place)
  const defaults = (await customerDefaultsOf(tools.tx, [order.partyId])).get(order.partyId) ?? null
  const own = (await orderSupervisorsOf(tools.tx, [order.id])).get(order.id) ?? null
  const supervisor = effectiveSupervisor(own, defaults?.supervisorId ?? null).userId
  const named: string[] = []
  for (const userId of [supervisor, defaults?.backupId ?? null]) {
    if (userId === null || named.includes(userId)) continue
    const reader = await context.reader(userId)
    if (reader && reads(reader.actor)) named.push(userId)
  }
  if (named.length > 0) return named
  const managers: string[] = []
  for (const userId of await context.people()) {
    const reader = await context.reader(userId)
    if (reader && can(reader.actor, PRODUCTION_BRAND_MANAGE, place) && reads(reader.actor)) managers.push(userId)
  }
  return managers.slice(0, 50)
}

// ---- the command ---------------------------------------------------------------------------------------------------------------

export interface ChangeNotesResult {
  readonly messageId: string | null
  readonly floorNotes: number
  readonly workshops: number
  readonly stillToDo: number
}

const NOTHING: ChangeNotesResult = { messageId: null, floorNotes: 0, workshops: 0, stillToDo: 0 }

async function writeNotes(tools: CommandTools, tenantId: string, spoken: Spoken, event: Envelope): Promise<ChangeNotesResult> {
  const { tx } = tools
  const at = asDate(event.occurredAt)
  const order = await orderFactsOf(tx, spoken.orderId)
  const context = tools.context
  // Every command records its audit row, even when the change wrote nothing (a replay then answers from its receipt).
  if (!order || (context.audience !== 'office' && context.audience !== 'system')) {
    tools.audit({ action: ORDER_CHANGE_NOTES_HANDLER, recordType: 'SalesOrder', recordId: spoken.orderId, companyId: null, after: { eventType: event.type, written: false } })
    return NOTHING
  }
  const composed = await compose(tools, tenantId, order, spoken.speaker, event.correlationId, at)
  if (!composed) {
    tools.audit({ action: ORDER_CHANGE_NOTES_HANDLER, recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { eventType: event.type, written: false } })
    return NOTHING
  }

  // The workshops told of this change (B-SA-054): the open subcontract orders of the noted work orders whose quantities change,
  // and whose workshop has someone to read it (else Still to do keeps "Tell the outside workshop").
  const notes = [...composed.floor.values()].sort((a, b) => a.workOrder.number.localeCompare(b.workOrder.number))
  const quantity = notes.filter((note) => note.changes.some((change) => WORKSHOP_CHANGES.includes(change.kind)))
  const subcontracts = await openSubcontractsOf(tx, quantity.map((note) => note.workOrder.id))
  const workshops: { id: string; number: string; workOrderId: string }[] = []
  for (const entry of subcontracts) {
    const row = await tx.subcontractOrder.findUnique({ where: { id: entry.id }, select: { partyId: true, companyId: true } })
    if (row && (await partyReaders(tx, tenantId, row.partyId, row.companyId, tools.now)).length > 0) workshops.push(entry)
  }

  // Still to do after this change (B-SA-050, as the records say), less the workshops this very change tells now.
  const still = await stillToDoOf(tx, context, order)
  let stillToDo = still.count
  if (composed.requestId && workshops.length > 0) {
    const request = await tx.orderChangeRequest.findUnique({ where: { id: composed.requestId }, select: { answeredAt: true } })
    if (request?.answeredAt) {
      const changed = [...new Set((await tx.workOrderChange.findMany({ where: { requestId: composed.requestId, workOrderId: { not: null } }, select: { workOrderId: true } })).map((row) => row.workOrderId!))]
      const open = await openSubcontractsOf(tx, changed)
      const told = await toldSubcontractsOf(tx, open.map((entry) => entry.id), request.answeredAt)
      const nowTold = new Set(workshops.map((entry) => entry.id))
      stillToDo -= open.filter((entry) => !told.has(entry.id) && nowTold.has(entry.id)).length
    }
  }
  stillToDo = Math.max(0, stillToDo)

  // The threads: the order's, then each noted work order's.
  const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order.id }, null)
  const woThreads = new Map<string, Awaited<ReturnType<typeof ensureThread>>['thread']>()
  for (const note of notes) woThreads.set(note.workOrder.id, (await ensureThread(tools, { type: 'WorkOrder', id: note.workOrder.id }, null)).thread)

  // B-PR-32 told the supervisor and the backup of the customer's own withdrawal (APPROVAL): not a second time here.
  const alreadyTold = composed.head.kind === 'WITHDRAWN' ? await withdrawalToldOf(tools, tenantId, order) : []
  const skip = new Set(alreadyTold)
  const people = await toldPeople(
    tools,
    tenantId,
    [{ type: 'SalesOrder', id: order.id, thread }, ...notes.map((note) => ({ type: 'WorkOrder', id: note.workOrder.id, thread: woThreads.get(note.workOrder.id)! }))],
    composed.causedById,
    skip,
  )
  const closing = composed.closes && stillToDo === 0 ? { at: composed.closes } : null
  const text = systemLineOf(
    {
      head: composed.head,
      at,
      asked: composed.asked,
      answer: composed.answer,
      done: composed.done,
      next: composed.next,
      // Everyone told of the act: the bell's people, and those B-PR-32's notice of the same act told.
      told: { people: new Set([...people, ...alreadyTold]).size, floor: notes.map((note) => labelOf(order, note.workOrder)), workshops: notes.filter((note) => workshops.some((entry) => entry.workOrderId === note.workOrder.id)).map((note) => labelOf(order, note.workOrder)) },
      closing,
    },
    order.locale,
    order.timeZone,
  )
  const change = { causedById: composed.causedById, orderId: order.id, stillToDo, alreadyTold }
  const line = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text), change })

  // The floor notes (B-SA-053): the site's first floor language, the customer's code only on a work order of that customer alone.
  const floorWritten: { workOrderId: string; messageId: string }[] = []
  for (const note of notes) {
    const site = await tx.site.findUnique({ where: { id: note.workOrder.siteId }, select: { floorLocales: true } })
    const locale = localeOf(site?.floorLocales[0])
    const body = floorNoteOf({ workOrder: note.workOrder.number, customerCode: note.workOrder.partyId === order.partyId ? order.customerCode : null, changes: note.changes }, locale)
    const message = await writeMessage(tools, woThreads.get(note.workOrder.id)!, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(body), forFloor: true, change: { causedById: composed.causedById, orderId: order.id, alreadyTold } })
    floorWritten.push({ workOrderId: note.workOrder.id, messageId: message.id })
    tools.emit({
      type: 'production.floor_note_posted',
      subject: note.workOrder.id,
      companyId: note.workOrder.companyId,
      siteId: note.workOrder.siteId,
      payload: { workOrderId: note.workOrder.id, number: note.workOrder.number, siteId: note.workOrder.siteId, partyId: note.workOrder.partyId, messageId: message.id, salesOrderId: order.id, changes: [...new Set(note.changes.map((entry) => entry.kind))] },
    })
  }

  tools.audit({
    action: ORDER_CHANGE_NOTES_HANDLER,
    recordType: 'SalesOrder',
    recordId: order.id,
    companyId: order.companyId,
    after: {
      eventType: event.type,
      written: true,
      messageId: line.id,
      at: at.toISOString(),
      causedById: composed.causedById,
      stillToDo,
      // F-SA-244: the customer's request the change carries out (null: the office's own) — the line's card counts its Still to do rows.
      requestId: composed.requestId ?? null,
      people: people.length,
      alreadyTold,
      floor: floorWritten,
      workshops: workshops.map((entry) => ({ subcontractOrderId: entry.id, workOrderId: entry.workOrderId })),
    },
  })
  return { messageId: line.id, floorNotes: floorWritten.length, workshops: workshops.length, stillToDo }
}

/** One event's notes (the handler's work; tests call it with the system caller). What each order's command wrote. */
export async function orderChangeNotes(caller: CommandCaller, event: Envelope): Promise<ChangeNotesResult[]> {
  const context = caller.factoryContext
  const tenantId = context && 'tenantId' in context ? context.tenantId : undefined
  if (!tenantId) return []
  const spoken = await caller.withClient((db) => spokenOf(db, event))
  const out: ChangeNotesResult[] = []
  for (const entry of spoken.sort((a, b) => a.orderId.localeCompare(b.orderId))) {
    const { result } = await command(
      caller,
      { name: ORDER_CHANGE_NOTES_HANDLER, idempotencyKey: changeNotesKey(event.correlationId, entry.orderId), input: { correlationId: event.correlationId, orderId: entry.orderId }, causationId: event.eventId },
      (tools) => writeNotes(tools, tenantId, entry, event),
    )
    out.push(result)
  }
  return out
}

/** The worker's `sales.orderChangeNotes` (background.ts W2B_SA52_HANDLERS; golden-flow/daily/testing/day.ts names it too). */
export function orderChangeNotesHandler(): EventHandler {
  return defineHandler({
    name: ORDER_CHANGE_NOTES_HANDLER,
    events: ORDER_CHANGE_NOTE_EVENTS,
    attempts: 5,
    async handle(event, { caller }) {
      await orderChangeNotes(caller, event)
    },
  })
}
