import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, toUtcIso } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { assertOneParty, urgencyChangedEvent, type URGENCY_CHANGES } from '@nexus/factory-domain/production-brand/events'
import {
  listCompare,
  markDecision,
  placeInUrgentList,
  ranksOf,
  undoPlan,
  urgentOrderProblems,
  usedOf,
  type BrandUrgency,
  type UndoEntry,
  type UrgencyActor,
  type UrgencyOutcome,
  type UrgencyRow,
  type UrgentUse,
} from '@nexus/factory-domain/production-brand/urgency'
import {
  ASK_US_WORDS,
  CHANGED_BY_US_SINCE_WORDS,
  CHANGED_SINCE_WORDS,
  changedAtWords,
  NOT_KEPT_YET_WORDS,
  NOT_IN_PRODUCTION_WORDS,
  NOTHING_TO_UNDO_WORDS,
  NOTHING_UNDONE_WORDS,
  URGENCY_NOT_OPEN_WORDS,
  URGENT_ORDER_UNCHANGED_WORDS,
  urgentUsedWords,
} from '@nexus/factory-domain/production-brand/words'
import type { CutStart } from '@nexus/factory-domain/sales/change-requests/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { readCuts } from '../../sales/change-requests/store'
import { dayOf, type Reader } from '../work-orders/store'
import { isKeptState, KEEPER_ORDER_STATES } from './facts'

/**
 * B-PR-22a — the customer's urgency of its orders, the command core (production plan §3 "Customer urgency", §5 Portal › My
 * production; lead picks L17, L18, L20, L25; review fixes R-48, R-49, R-61, R-65; the Owner's point N2: "manage the urgency or
 * reorder their orders by urgency, making the urgent ones come to the top and the regular ones normally arranged by the date
 * sent … give control to the brands while still having control"; the Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well."). The portal's routes are ./../brand-portal/urgency.ts; B-PR-22b (the office's set-back, lock, unlock, the Customer card
 * list) and B-PR-27b (an accepted "Urgent – asked") build on the same core.
 *
 *   the scope   ONE customer's orders at ONE company (the portal's company; the office: the order's): its urgent list, its quota
 *               ("2 of 3 urgent used") and its ranks are of those orders, as the customer's My production reads them (B-PR-18)
 *   the lock    every command takes the customer's own lock first: an advisory lock of the party, then its PortalSettings row
 *               FOR UPDATE (the switch and the quota as they are now; the limits card's write waits). There is no database key on
 *               urgentRank (B-PR-15): under the lock the open Urgent list is rewritten 1..n, so two commands never leave two
 *               orders on one place
 *   the mark    factory-domain production-brand/urgency markDecision over the row as read under the lock and the LIVE cut facts
 *               read in the command (a cut of leather logged or a bundle made of one of the order's cells: sales/change-requests
 *               readCuts; never BrandOrderProduction.stage, which the keeper writes later: R-61): at once inside the quota and
 *               before Cutting; over the quota or from Cutting it is refused with the words "Ask us" until B-PR-46a turns it
 *               into an "Urgent – asked"; back to Regular is always free; refused while we locked the order
 *   the batch   every changed row is stamped with the command's batch (urgencyBatchId) and its state before (urgency,
 *               urgentRank) is kept in the command's ONE audit row (`before.orders`); an Undo reads that row and puts back only
 *               the rows whose batch is still this one (R-49); the drag of the Urgent list the same (the moved rows)
 *   the wall    one audit row (recordType Party, the customer) and one brand_production.urgency_changed per command, naming only
 *               that customer's own orders (assertOneParty); nothing here returns another customer's order, place or count. It
 *               never writes SalesOrder.priority, priorityLevel, backlogRank, WorkOrder.priority or rush: the office's levers
 *               stay the office's (planning's brand-slot pass reads the marks: planning/backlog/rank brandSlots)
 */

// ---- the rows -----------------------------------------------------------------------------------------------------------------

/** The customer's switch and quota (PortalSettings; no row: urgency off). */
export interface UrgencySettings {
  readonly urgencyOn: boolean
  readonly max: number
}

/** One order of the customer as the urgency commands read it: BrandOrderProduction beside its SalesOrder. */
export interface UrgencyOrderRow extends UrgencyRow {
  /** BrandOrderProduction.id. */
  readonly rowId: string
  readonly companyId: string
  readonly customerRef: string | null
  readonly status: string
  readonly batchId: string | null
  readonly setAt: Date | null
  readonly setById: string | null
  readonly lockedAt: Date | null
  readonly lockedById: string | null
  readonly version: number
}

const ROW_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  salesOrderId: true,
  key: true,
  urgency: true,
  urgentRank: true,
  urgencySetAt: true,
  urgencySetBy: true,
  urgencySetById: true,
  urgencyBatchId: true,
  urgencyLocked: true,
  urgencyLockReason: true,
  urgencyLockedAt: true,
  urgencyLockedById: true,
  version: true,
  salesOrder: { select: { number: true, customerRef: true, orderDate: true, createdAt: true, status: true } },
} as const satisfies Prisma.BrandOrderProductionSelect

type StoredRow = Prisma.BrandOrderProductionGetPayload<{ select: typeof ROW_SELECT }>

const rowOf = (row: StoredRow): UrgencyOrderRow => ({
  rowId: row.id,
  orderId: row.salesOrderId,
  partyId: row.partyId,
  companyId: row.companyId,
  number: row.salesOrder.number,
  customerRef: row.salesOrder.customerRef,
  orderDate: dayOf(row.salesOrder.orderDate),
  createdAt: row.salesOrder.createdAt,
  status: row.salesOrder.status,
  urgency: row.urgency as BrandUrgency,
  urgentRank: row.urgentRank,
  setBy: row.urgencySetBy as UrgencyActor | null,
  setAt: row.urgencySetAt,
  setById: row.urgencySetById,
  batchId: row.urgencyBatchId,
  locked: row.urgencyLocked,
  lockReason: row.urgencyLockReason,
  lockedAt: row.urgencyLockedAt,
  lockedById: row.urgencyLockedById,
  open: isKeptState(row.salesOrder.status),
  version: row.version,
})

/**
 * The customer's orders at one company as the urgency commands read them: every order still in production (CONFIRMED,
 * IN_PRODUCTION, READY, PARTLY_SHIPPED: the keeper's set, the same as the portal's "n of max used"), and the orders named
 * (an order that left production reads `open: false`: "no longer in production"). One row per order (the order's own key).
 */
export async function readUrgencyRows(db: Reader, scope: { readonly partyId: string; readonly companyId: string; readonly orderIds?: readonly string[] }): Promise<UrgencyOrderRow[]> {
  const named = scope.orderIds ?? []
  const rows = await db.brandOrderProduction.findMany({
    where: {
      partyId: scope.partyId,
      companyId: scope.companyId,
      OR: [{ salesOrder: { status: { in: [...KEEPER_ORDER_STATES] } } }, ...(named.length > 0 ? [{ salesOrderId: { in: [...named] } }] : [])],
    },
    select: ROW_SELECT,
    orderBy: [{ salesOrderId: 'asc' }, { key: 'asc' }],
  })
  // One per order: its own key (`brand-production:<order>`).
  return rows.filter((row) => row.key === `brand-production:${row.salesOrderId}`).map(rowOf)
}

/** The open Urgent list of these rows, in its order (urgentRank 1 first). */
export const urgentListOf = (rows: readonly UrgencyOrderRow[]): string[] =>
  rows
    .filter((row) => row.open && row.urgency === 'URGENT')
    .sort(listCompare)
    .map((row) => row.orderId)

/**
 * The customer's own lock (every urgency command takes it first): an advisory lock of the party, then its PortalSettings row
 * FOR UPDATE — the switch and the quota as they are now (the limits card's write waits for the command). No row: urgency off.
 */
export async function lockCustomerUrgency(tx: CommandTx, partyId: string): Promise<UrgencySettings> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.brand-urgency', ${partyId}::uuid), 0))`
  const rows = await tx.$queryRaw<{ partyId: string; productionUrgencyOn: boolean; productionUrgentMax: number }[]>`
    SELECT "partyId", "productionUrgencyOn", "productionUrgentMax" FROM "PortalSettings" WHERE id = ${partyId}::uuid FOR UPDATE`
  const row = rows[0]
  return row && row.partyId === partyId ? { urgencyOn: row.productionUrgencyOn, max: row.productionUrgentMax } : { urgencyOn: false, max: 0 }
}

/** The customer's switch and quota, read (no lock: the reads). */
export async function readUrgencySettings(db: Reader, partyId: string): Promise<UrgencySettings> {
  const row = await db.portalSettings.findUnique({ where: { id: partyId }, select: { partyId: true, productionUrgencyOn: true, productionUrgentMax: true } })
  return row && row.partyId === partyId ? { urgencyOn: row.productionUrgencyOn, max: row.productionUrgentMax } : { urgencyOn: false, max: 0 }
}

/** The LIVE cut facts of these orders (R-61): each order's first cut — leather logged or a bundle made of one of its cells. */
export async function liveCutsOf(db: Reader, orderIds: readonly string[]): Promise<Map<string, CutStart>> {
  const out = new Map<string, CutStart>()
  if (orderIds.length === 0) return out
  const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: [...orderIds] } }, select: { id: true, orderId: true } })
  const cuts = await readCuts(db, lines.map((line) => line.id))
  for (const line of lines) {
    const cut = cuts.get(line.id)
    if (!cut) continue
    const known = out.get(line.orderId)
    if (!known || cut.day < known.day || (cut.day === known.day && cut.leather && !known.leather)) out.set(line.orderId, cut)
  }
  return out
}

/** "2 of 3 urgent used" of these rows (its own open orders only) with its words. */
export function useOf(rows: readonly UrgencyOrderRow[], partyId: string, max: number): UrgentUse & { readonly words: Words } {
  const use = usedOf(rows, { partyId, max })
  return { ...use, words: urgentUsedWords(use) }
}

/** A time of day in company time (hh:mm) for "Changed at 10:42". */
export const clockWords = (at: Date): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: BUSINESS_TIME_ZONE }).format(at)

// ---- the writes ---------------------------------------------------------------------------------------------------------------

export type UrgencyChange = (typeof URGENCY_CHANGES)[number]

/** An order's urgency as an audit row keeps it (the "before" an Undo reads; R-49). */
export interface UrgencyState {
  readonly orderId: string
  readonly urgency: BrandUrgency
  readonly urgentRank: number | null
}

const stateOf = (row: Pick<UrgencyOrderRow, 'orderId' | 'urgency' | 'urgentRank'>): UrgencyState => ({ orderId: row.orderId, urgency: row.urgency, urgentRank: row.urgentRank })

/** What one urgency write does to the customer's rows. */
interface UrgencyWrite {
  readonly rows: readonly UrgencyOrderRow[]
  /** The new urgency of the orders whose urgency the command changes. */
  readonly urgency: ReadonlyMap<string, BrandUrgency>
  /** The open Urgent list after the command, in order (written as the ranks 1..n). */
  readonly urgentList: readonly string[]
  /** The rows the command stamps with its batch: their state before goes into the audit row. */
  readonly batchRows: ReadonlySet<string>
  readonly batchId: string
  readonly by: UrgencyActor
  /** The person (a portal person of the customer for BRAND, an office person for FACTORY; null: the system). */
  readonly byId: string | null
}

/**
 * Writes the rows: each changed urgency (with who and when), every open urgent order's rank 1..n of the new list, the batch on the
 * batch's rows; each write moves the row's version. Returns the rows' states before and after (the batch's) for the audit row.
 */
async function writeUrgency(tools: CommandTools, write: UrgencyWrite): Promise<{ before: UrgencyState[]; after: UrgencyState[] }> {
  const ranks = ranksOf(write.urgentList)
  const before: UrgencyState[] = []
  const after: UrgencyState[] = []
  for (const row of write.rows) {
    const urgency = write.urgency.get(row.orderId) ?? row.urgency
    const flipped = urgency !== row.urgency
    // A row no longer in production keeps its last urgency as history (only a named one may still go back to Regular).
    const urgentRank = urgency === 'URGENT' ? (row.open ? (ranks.get(row.orderId) ?? null) : row.urgentRank) : null
    if (urgency === 'URGENT' && urgentRank === null) throw new Error(`production urgency: order ${row.orderId} is Urgent with no place in its customer's list`)
    const stamped = write.batchRows.has(row.orderId)
    if (!flipped && !stamped && urgentRank === row.urgentRank) continue
    await tools.tx.brandOrderProduction.update({
      where: { id: row.rowId },
      data: {
        urgentRank,
        ...(flipped ? { urgency, urgencySetAt: tools.now, urgencySetBy: write.by, urgencySetById: write.byId } : {}),
        ...(stamped ? { urgencyBatchId: write.batchId } : {}),
        updatedAt: tools.now,
        version: { increment: 1 },
      },
      select: { id: true },
    })
    if (stamped) {
      before.push(stateOf(row))
      after.push({ orderId: row.orderId, urgency, urgentRank })
    }
  }
  return { before, after }
}

/** The one audit row and the one event of a customer's urgency command (its own party, its own orders only: R-48). */
function record(
  tools: CommandTools,
  input: {
    readonly action: string
    readonly partyId: string
    readonly companyId: string
    readonly batchId: string
    readonly by: UrgencyActor
    readonly byId: string | null
    readonly change: UrgencyChange
    readonly undo: boolean
    readonly undoOf?: string
    readonly locked: boolean
    readonly reason?: string | null
    readonly before: readonly UrgencyState[]
    readonly after: readonly UrgencyState[]
    readonly rows: readonly UrgencyOrderRow[]
  },
): void {
  tools.audit({
    action: input.action,
    recordType: 'Party',
    recordId: input.partyId,
    companyId: input.companyId,
    before: { partyId: input.partyId, orders: input.before },
    after: {
      partyId: input.partyId,
      batchId: input.batchId,
      by: input.by,
      byId: input.byId,
      change: input.change,
      undo: input.undo,
      ...(input.undoOf ? { undoOf: input.undoOf } : {}),
      locked: input.locked,
      orders: input.after,
    },
    ...(input.reason ? { reason: input.reason } : {}),
  })
  const partyOf = new Map(input.rows.map((row) => [row.orderId, row.partyId]))
  // One event per urgency the named orders have now (an undo putting orders back to both says each; one batch, one customer).
  for (const urgency of ['URGENT', 'REGULAR'] as const) {
    const orderIds = input.after.filter((state) => state.urgency === urgency).map((state) => state.orderId)
    if (orderIds.length === 0) continue
    const share = { companyId: input.companyId, partyId: input.partyId, orderIds }
    assertOneParty(share, partyOf)
    tools.emit(urgencyChangedEvent(share, { urgency, by: input.by, change: input.change, locked: input.locked, undo: input.undo, asked: false, batchId: input.batchId }))
  }
}

// ---- the customer's mark (portal: POST /portal/production/urgency) ------------------------------------------------------------

export interface UrgencyResult {
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly outcome: UrgencyOutcome
  readonly done: boolean
  readonly words: Words | null
  /** "Ask us" beside an over-quota or at-Cutting mark (the way to "Urgent – asked"; B-PR-46a). */
  readonly ask: Words | null
  /** The order's urgency and place in the customer's own list after the command (null: not known). */
  readonly urgency: BrandUrgency | null
  readonly urgentRank: number | null
}

/** One order a portal command names: its own order (the partner read found it), where it stood in the body. */
export interface NamedOrder {
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly status: string
  readonly index: number
}

export interface MarkInput {
  readonly partyId: string
  readonly companyId: string
  /** The portal person (BrandOrderProduction.urgencySetById; the guard checks it is a person of this customer). */
  readonly userId: string
  readonly urgency: BrandUrgency
  readonly orders: readonly NamedOrder[]
}

export interface UrgencyOutcomeView {
  readonly batchId: string | null
  readonly results: readonly UrgencyResult[]
  readonly use: (UrgentUse & { readonly words: Words }) | null
}

/** The refusal of a command that changed nothing: every row in words at its place in the body (409). */
function nothingChanged(results: readonly UrgencyResult[], orders: readonly NamedOrder[], fallback: Words): DomainError {
  const issues: Issue[] = results.flatMap((result) => {
    const index = orders.find((order) => order.orderId === result.orderId)?.index ?? 0
    return result.words ? [{ path: `body/orderIds/${index}/${result.outcome}`, message: result.words.en }] : []
  })
  return new DomainError('conflict', issues.length === 1 ? issues[0]!.message : fallback.en, issues)
}

const refusalOf = (outcome: UrgencyOutcome, order: NamedOrder, words: Words, row: UrgencyOrderRow | undefined, ask: Words | null = null): UrgencyResult => ({
  orderId: order.orderId,
  number: order.number,
  customerRef: order.customerRef,
  outcome,
  done: false,
  words,
  ask,
  urgency: row?.urgency ?? null,
  urgentRank: row?.urgentRank ?? null,
})

/**
 * The customer marks its own orders Urgent or Regular (one or many, max 50; one command): under its lock, each order in the body's
 * order by markDecision over the row now and the live cut facts; a new Urgent goes to the end of its list. Writes, audits and
 * tells only when one order changed (else 409 with each order's words).
 */
export async function markInCommand(tools: CommandTools, input: MarkInput): Promise<UrgencyOutcomeView> {
  const settings = await lockCustomerUrgency(tools.tx, input.partyId)
  const rows = await readUrgencyRows(tools.tx, { partyId: input.partyId, companyId: input.companyId, orderIds: input.orders.map((order) => order.orderId) })
  const byId = new Map(rows.map((row) => [row.orderId, row]))
  const cuts = input.urgency === 'URGENT' ? await liveCutsOf(tools.tx, input.orders.map((order) => order.orderId)) : new Map<string, CutStart>()
  let used = usedOf(rows, { partyId: input.partyId, max: settings.max }).used
  const urgency = new Map<string, BrandUrgency>()
  const marked: string[] = []
  const unmarked = new Set<string>()
  const results: UrgencyResult[] = []
  for (const order of input.orders) {
    const row = byId.get(order.orderId)
    if (!row) {
      results.push(isKeptState(order.status) ? refusalOf('NOT_KEPT', order, NOT_KEPT_YET_WORDS, row) : refusalOf('NOT_OPEN', order, NOT_IN_PRODUCTION_WORDS, row))
      continue
    }
    const decision = markDecision(input.urgency, { urgencyOn: settings.urgencyOn, max: settings.max, row, used, cut: cuts.get(row.orderId) ?? null })
    if (decision.outcome === 'ASK') {
      results.push(refusalOf(decision.reason === 'CUT' ? 'ASK_CUT' : 'ASK_OVER_QUOTA', order, decision.words, row, ASK_US_WORDS))
      continue
    }
    if (decision.outcome === 'REFUSED') {
      results.push(refusalOf(decision.code, order, decision.words, row))
      continue
    }
    urgency.set(row.orderId, input.urgency)
    if (input.urgency === 'URGENT') {
      marked.push(row.orderId)
      used += 1
    } else {
      unmarked.add(row.orderId)
      used -= 1
    }
    results.push({ orderId: order.orderId, number: order.number, customerRef: order.customerRef, outcome: 'DONE', done: true, words: null, ask: null, urgency: input.urgency, urgentRank: null })
  }
  if (urgency.size === 0) throw nothingChanged(results, input.orders, URGENCY_NOT_OPEN_WORDS)

  const batchId = newId()
  const urgentList = [...urgentListOf(rows).filter((orderId) => !unmarked.has(orderId)), ...marked]
  const { before, after } = await writeUrgency(tools, { rows, urgency, urgentList, batchRows: new Set(urgency.keys()), batchId, by: 'BRAND', byId: input.userId })
  record(tools, { action: 'portal.production.urgency', partyId: input.partyId, companyId: input.companyId, batchId, by: 'BRAND', byId: input.userId, change: 'MARK', undo: false, locked: false, before, after, rows })
  const ranks = ranksOf(urgentList)
  const now = rows.map((row) => ({ ...row, urgency: urgency.get(row.orderId) ?? row.urgency, urgentRank: (urgency.get(row.orderId) ?? row.urgency) === 'URGENT' ? (ranks.get(row.orderId) ?? row.urgentRank) : null }))
  return {
    batchId,
    results: results.map((result) => (result.done ? { ...result, urgentRank: result.urgency === 'URGENT' ? (ranks.get(result.orderId) ?? null) : null } : result)),
    use: useOf(now, input.partyId, settings.max),
  }
}

// ---- the customer's Urgent list (portal: PUT /portal/production/urgent-order) ------------------------------------------------

export interface UrgentOrderInput {
  readonly partyId: string
  readonly companyId: string
  readonly userId: string
  /** Its WHOLE Urgent list in the new order (Move to top = the list with that order first). */
  readonly orderIds: readonly string[]
  /** When it read the list (the list's `asOf`): a change after it reads "Changed at 10:42" / "Changed by us". */
  readonly asOf: Date | null
}

/**
 * The customer puts its Urgent list in order (the drag, "Move to top"): under its lock, the list must be every open urgent order of
 * the customer at this company, each once (a Regular order: "Mark urgent first"; another customer's or no order: "Order not
 * found." at its place, never named). The moved rows get the batch; one audit row, one event (ORDER).
 */
export async function urgentOrderInCommand(tools: CommandTools, input: UrgentOrderInput): Promise<UrgencyOutcomeView> {
  const settings = await lockCustomerUrgency(tools.tx, input.partyId)
  const rows = await readUrgencyRows(tools.tx, { partyId: input.partyId, companyId: input.companyId })
  const problems = urgentOrderProblems(rows, { partyId: input.partyId, urgencyOn: settings.urgencyOn, orderIds: input.orderIds })
  if (problems.length > 0) {
    // A row it named or left out changed after it read the list: say when (or that we did), never who.
    const named = new Set(input.orderIds)
    const changed = input.asOf === null ? [] : rows.filter((row) => row.open && row.setAt !== null && row.setAt > input.asOf! && (named.has(row.orderId) || row.urgency === 'URGENT'))
    const latest = changed.sort((a, b) => b.setAt!.getTime() - a.setAt!.getTime())[0]
    if (latest) {
      const words = latest.setBy === 'FACTORY' ? CHANGED_BY_US_SINCE_WORDS : changedAtWords(clockWords(latest.setAt!))
      throw new DomainError('conflict', words.en, [{ path: 'body/orderIds/CHANGED_SINCE', message: words.en }, ...problems])
    }
    throw new DomainError('conflict', problems[0]!.message, problems)
  }
  const current = urgentListOf(rows)
  if (current.join('|') === input.orderIds.join('|')) throw new DomainError('conflict', URGENT_ORDER_UNCHANGED_WORDS.en, [{ path: 'body/orderIds', message: URGENT_ORDER_UNCHANGED_WORDS.en }])
  const ranks = ranksOf(input.orderIds)
  const moved = new Set(rows.filter((row) => ranks.has(row.orderId) && ranks.get(row.orderId) !== row.urgentRank).map((row) => row.orderId))
  const batchId = newId()
  const { before, after } = await writeUrgency(tools, { rows, urgency: new Map(), urgentList: input.orderIds, batchRows: moved, batchId, by: 'BRAND', byId: input.userId })
  record(tools, { action: 'portal.production.urgentOrder', partyId: input.partyId, companyId: input.companyId, batchId, by: 'BRAND', byId: input.userId, change: 'ORDER', undo: false, locked: false, before, after, rows })
  const byId = new Map(rows.map((row) => [row.orderId, row]))
  return {
    batchId,
    results: input.orderIds.map((orderId) => {
      const row = byId.get(orderId)!
      return { orderId, number: row.number, customerRef: row.customerRef, outcome: 'DONE' as const, done: true, words: null, ask: null, urgency: 'URGENT' as const, urgentRank: ranks.get(orderId)! }
    }),
    use: useOf(rows, input.partyId, settings.max),
  }
}

// ---- undo of a customer's batch (portal: POST /portal/production/urgency/undo) ------------------------------------------------

/** The audit actions of the customer's own urgency batches (an Undo puts back only these: never ours, never another customer's). */
export const PORTAL_URGENCY_ACTIONS = ['portal.production.urgency', 'portal.production.urgentOrder', 'portal.production.urgencyUndo'] as const

interface BatchAudit {
  readonly change: UrgencyChange
  readonly before: readonly UrgencyState[]
}

const isState = (value: unknown): value is UrgencyState =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as UrgencyState).orderId === 'string' &&
  ((value as UrgencyState).urgency === 'URGENT' || (value as UrgencyState).urgency === 'REGULAR') &&
  ((value as UrgencyState).urgentRank === null || typeof (value as UrgencyState).urgentRank === 'number')

/**
 * The customer's batch as its audit row kept it (its own party and company, one of its own commands); null: no such batch of this
 * customer (another customer's batch id, ours, or none: the same answer).
 */
async function readBatch(tx: CommandTx, scope: { readonly partyId: string; readonly companyId: string; readonly batchId: string }): Promise<BatchAudit | null> {
  const rows = await tx.$queryRaw<{ before: unknown; after: unknown }[]>`
    SELECT before, after FROM "AuditLog"
     WHERE "recordType" = 'Party' AND "recordId" = ${scope.partyId}::uuid AND "companyId" = ${scope.companyId}::uuid
       AND action = ANY(${[...PORTAL_URGENCY_ACTIONS]}::text[]) AND after->>'batchId' = ${scope.batchId}
     ORDER BY at, id LIMIT 1`
  const row = rows[0]
  if (!row) return null
  const after = row.after as { partyId?: unknown; change?: unknown } | null
  const before = row.before as { orders?: unknown } | null
  if (!after || after.partyId !== scope.partyId || !before || !Array.isArray(before.orders)) return null
  const change = after.change === 'ORDER' ? 'ORDER' : 'MARK'
  return { change, before: before.orders.filter(isState) }
}

export interface UndoInput {
  readonly partyId: string
  readonly companyId: string
  readonly userId: string
  readonly batchId: string
}

export interface UndoView extends UrgencyOutcomeView {
  readonly undone: string
  readonly skipped: readonly { readonly orderId: string; readonly number: string; readonly customerRef: string | null; readonly words: Words }[]
}

/**
 * Undo of one of the customer's own batches (R-49): its audit row's `before`, each row put back unless its batch changed since
 * (left as it is: "Changed since") or going back to Urgent breaks the mark's own rules now (locked, from Cutting — read live —,
 * over the quota: undoPlan); a row of a drag goes back to its place. The rows put back get a new batch (an Undo is itself undone
 * the same way); one audit row and one event (undo: true).
 */
export async function undoInCommand(tools: CommandTools, input: UndoInput): Promise<UndoView> {
  const settings = await lockCustomerUrgency(tools.tx, input.partyId)
  const batch = await readBatch(tools.tx, input)
  if (!batch || batch.before.length === 0) throw new NotFoundError(NOTHING_TO_UNDO_WORDS.en)
  const rows = await readUrgencyRows(tools.tx, { partyId: input.partyId, companyId: input.companyId, orderIds: batch.before.map((state) => state.orderId) })
  const byId = new Map(rows.map((row) => [row.orderId, row]))
  const entries: UndoEntry[] = batch.before.flatMap((state) => {
    const row = byId.get(state.orderId)
    return row ? [{ row, batchIdNow: row.batchId, before: { urgency: state.urgency, urgentRank: state.urgentRank } }] : []
  })
  const cuts = await liveCutsOf(
    tools.tx,
    entries.filter((entry) => entry.before.urgency === 'URGENT').map((entry) => entry.row.orderId),
  )
  const plan = undoPlan(input.batchId, entries, { partyId: input.partyId, urgencyOn: settings.urgencyOn, max: settings.max, used: usedOf(rows, { partyId: input.partyId, max: settings.max }).used, cuts })
  const skipped = new Map(plan.skipped.map((entry) => [entry.orderId, entry.words]))
  const urgency = new Map(plan.restore.map((entry) => [entry.orderId, entry.urgency]))
  // The places to put back: a row going back to Urgent, and a row of a drag still in this batch and still Urgent (its old place).
  const placed: { orderId: string; rank: number }[] = plan.restore.flatMap((entry) => (entry.urgency === 'URGENT' && entry.urgentRank !== null ? [{ orderId: entry.orderId, rank: entry.urgentRank }] : []))
  for (const entry of entries) {
    const { row } = entry
    if (entry.batchIdNow !== input.batchId || urgency.has(row.orderId) || skipped.has(row.orderId)) continue
    if (row.urgency !== 'URGENT' || entry.before.urgency !== 'URGENT' || entry.before.urgentRank === null || entry.before.urgentRank === row.urgentRank || !row.open) continue
    if (!settings.urgencyOn) {
      skipped.set(row.orderId, URGENCY_NOT_OPEN_WORDS)
      continue
    }
    placed.push({ orderId: row.orderId, rank: entry.before.urgentRank })
  }
  // Rows of the batch that left this command's reach (no row now) are left as they are.
  for (const state of batch.before) if (!byId.has(state.orderId)) skipped.set(state.orderId, CHANGED_SINCE_WORDS)
  const touched = new Set([...urgency.keys(), ...placed.map((entry) => entry.orderId)])
  const skippedView = [...skipped].flatMap(([orderId, words]) => {
    const row = byId.get(orderId)
    return row ? [{ orderId, number: row.number, customerRef: row.customerRef, words }] : []
  })
  if (touched.size === 0) {
    const issues: Issue[] = skippedView.map((entry) => ({ path: 'body/batchId/SKIPPED', message: `${entry.number}: ${entry.words.en}` }))
    throw new DomainError('conflict', NOTHING_UNDONE_WORDS.en, issues)
  }
  const current = urgentListOf(rows).filter((orderId) => urgency.get(orderId) !== 'REGULAR')
  const urgentList = placeInUrgentList(current, placed)
  const batchId = newId()
  const { before, after } = await writeUrgency(tools, { rows, urgency, urgentList, batchRows: touched, batchId, by: 'BRAND', byId: input.userId })
  record(tools, { action: 'portal.production.urgencyUndo', partyId: input.partyId, companyId: input.companyId, batchId, by: 'BRAND', byId: input.userId, change: batch.change, undo: true, undoOf: input.batchId, locked: false, before, after, rows })
  const ranks = ranksOf(urgentList)
  const now = rows.map((row) => {
    const next = urgency.get(row.orderId) ?? row.urgency
    return { ...row, urgency: next, urgentRank: next === 'URGENT' && row.open ? (ranks.get(row.orderId) ?? row.urgentRank) : null }
  })
  return {
    batchId,
    undone: input.batchId,
    results: after.map((state) => {
      const row = byId.get(state.orderId)!
      return { orderId: state.orderId, number: row.number, customerRef: row.customerRef, outcome: 'DONE' as const, done: true, words: null, ask: null, urgency: state.urgency, urgentRank: state.urgentRank }
    }),
    skipped: skippedView,
    use: useOf(now, input.partyId, settings.max),
  }
}

/** The audit row's "when" as the reads give it. */
export const isoOrNull = (at: Date | null): string | null => (at ? toUtcIso(at) : null)
