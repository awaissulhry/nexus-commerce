import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNED_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import { NO_SUPPLY_RULES, orderByOf, suggestionFor } from '@nexus/factory-domain/planning/buy'
import { decisionNoteOf, decisionProblem, setAsideProblems, type Decision, type SetAsideReason } from '@nexus/factory-domain/planning/decisions'
import { bridgeOf, sentenceOf } from '@nexus/factory-domain/planning/explain'
import { netMaterial } from '@nexus/factory-domain/planning/netting'
import { pegMaterial, type DemandPart } from '@nexus/factory-domain/planning/mrp/net'
import type { RequirementSource } from '@nexus/factory-domain/planning/explode'
import { quantityWords } from '@nexus/factory-domain/planning/explain'
import { buyFromSource, sourceFor } from '@nexus/factory-domain/purchasing/sources/sources'
import { PLANNING_DECIDE, PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { NOT_COUNTED_WORDS, type NotCountedReason } from '@nexus/factory-domain/planning/usable'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { assertMayAt, officeContextOf, seesCost, siteFor } from './access'
import type { LineView, RunView } from './contract'
import { readReservations } from './inputs'
import { PEG_COLUMNS, pegTreeView, type PegRowRead } from './pegging/read'
import { dayOf, lotFactsOf, readLots, readPurchases, readStock, unitsOf, type LotRow, type PlanStockRow, type Reader } from './store'
import { lineViewOf, quantityOf, readLineContext, REQUIREMENT_COLUMNS, RUN_COLUMNS, runCounts, runViewOf, sourcesOf, type RequirementRow, type RunRow } from './views'

/**
 * The plan's reads and the decisions on its lines (B-W1-29; A2 SCR-055; design 02 "What to buy & make"): the latest
 * plan of a site (or one run) with its tiles and lines, a line's explanation ("Why this number"), the run history, the
 * stock the plan may not use, and setting lines aside (or opening them again). Reads are read-only; every decision is a
 * command on the run (its version bump locks it against a new run superseding it meanwhile), then compare-and-set on
 * each line's version.
 */

const todayAt = (timezone: string): BusinessDate => businessDate(serverClock.now(), timezone)

export interface LinesFilter {
  readonly itemId?: string | undefined
  readonly supplierId?: string | undefined
  readonly action?: 'BUY' | 'MAKE' | undefined
  readonly decision?: Decision | undefined
  readonly shortOnly?: boolean | undefined
}

const isShort = (line: { readonly netQuantity: string }): boolean => new Dec(line.netQuantity).gt(0)

/** The whole plan view of one run of a site (tiles from every line; lines filtered). */
async function planOf(db: Reader, context: OfficeContext, run: RunRow | null, siteId: string, timezone: string, filter: LinesFilter) {
  const withCost = seesCost(context)
  // A run started after the plan shown that did not finish it: running now, or failed (the plan shown stays).
  const latestAttempt = await db.planningRun.findFirst({
    where: { siteId, status: { in: ['RUNNING', 'FAILED'] }, ...(run ? { startedAt: { gt: run.startedAt } } : {}) },
    select: RUN_COLUMNS,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
  const counts = await runCounts(db, [run?.id, latestAttempt?.id].filter((id): id is string => !!id))
  const summary = { toBuy: 0, orderByPassed: 0, toMake: 0, inDraftPurchaseOrder: 0, ordered: 0, setAside: 0, shortWithHeldStock: 0, firm: 0 }
  if (!run) return { run: null, latestAttempt: latestAttempt ? runViewOf(latestAttempt, counts.get(latestAttempt.id)!) : null, summary, outOfDate: null, lines: [] }
  const rows = await db.materialRequirement.findMany({ where: { runId: run.id }, select: REQUIREMENT_COLUMNS, orderBy: { seq: 'asc' } })
  const lineContext = await readLineContext(db, rows, withCost)
  const today = todayAt(timezone)
  const all = rows.map((row) => lineViewOf(row, lineContext, today, withCost))
  const ordered = rows.flatMap((row) => (row.purchaseOrderLineId ? [row.purchaseOrderLineId] : []))
  const drafts = new Set(
    ordered.length === 0 ? [] : (await db.purchaseOrderLine.findMany({ where: { id: { in: ordered }, purchaseOrder: { status: 'DRAFT' } }, select: { id: true } })).map((line) => line.id),
  )
  for (const line of all) {
    const short = isShort(line)
    if (line.decision === 'OPEN' && short && line.action === 'BUY') summary.toBuy++
    if (line.decision === 'OPEN' && short && line.action === 'BUY' && line.orderBy?.passed) summary.orderByPassed++
    if (line.decision === 'OPEN' && short && line.action === 'MAKE') summary.toMake++
    if (line.decision === 'ORDERED') summary.ordered++
    if (line.decision === 'ORDERED' && line.purchaseOrderLineId && drafts.has(line.purchaseOrderLineId)) summary.inDraftPurchaseOrder++
    if (line.decision === 'IGNORED') summary.setAside++
    if (short && new Dec(line.heldStock).gt(0)) summary.shortWithHeldStock++
    if (line.firm) summary.firm++
  }
  const lines = all.filter(
    (line) =>
      (!filter.itemId || line.item.id === filter.itemId) &&
      (!filter.supplierId || line.supplier?.id === filter.supplierId) &&
      (!filter.action || line.action === filter.action) &&
      (!filter.decision || line.decision === filter.decision) &&
      (!filter.shortOnly || isShort(line)),
  )
  return {
    run: runViewOf(run, counts.get(run.id)!),
    latestAttempt: latestAttempt ? runViewOf(latestAttempt, counts.get(latestAttempt.id)!) : null,
    summary,
    outOfDate: run.finishedAt ? await outOfDateSince(db, run.companyId, siteId, run.finishedAt) : null,
    lines,
  }
}

/**
 * B-W2a-22 (the W1 leftover "out of date since the run"; design planning.mrp run strip "3 orders confirmed, 2 receipts
 * posted, 1 lot released (each a link)"): what changed at the site after the plan finished, read from the records
 * themselves (an order is made confirmed; a receipt's postedAt; a lot's quality decision). null when nothing did.
 */
async function outOfDateSince(db: Reader, companyId: string, siteId: string, since: Date) {
  const ordersConfirmed = await db.salesOrder.findMany({
    where: { companyId, createdAt: { gt: since }, status: { in: [...PLANNED_ORDER_STATUSES] }, lines: { some: { OR: [{ siteId }, { siteId: null }] } } },
    select: { id: true, number: true },
    orderBy: { number: 'asc' },
    take: 50,
  })
  const receiptsPosted = await db.goodsReceipt.findMany({ where: { siteId, postedAt: { gt: since } }, select: { id: true, number: true }, orderBy: { number: 'asc' }, take: 50 })
  const lots = await db.lot.findMany({ where: { siteId, qualityDecidedAt: { gt: since } }, select: { id: true, code: true, qualityStatus: true }, orderBy: { code: 'asc' }, take: 100 })
  const lotsReleased = lots.filter((lot) => lot.qualityStatus === 'RELEASED').map(({ id, code }) => ({ id, code }))
  const lotsHeld = lots.filter((lot) => lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED').map(({ id, code }) => ({ id, code }))
  if (ordersConfirmed.length + receiptsPosted.length + lotsReleased.length + lotsHeld.length === 0) return null
  return { since: toUtcIso(since), ordersConfirmed, receiptsPosted, lotsReleased, lotsHeld }
}

/** GET /planning/runs/latest: the site's latest DONE plan. */
export async function latestPlan(caller: CommandCaller, query: { readonly siteId: string } & LinesFilter) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const run = await db.planningRun.findFirst({ where: { siteId: site.id, status: 'DONE' }, select: RUN_COLUMNS, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] })
    return planOf(db, context, run, site.id, site.timezone, query)
  })
}

async function runFor(caller: CommandCaller, db: Reader, runId: string, permission: Permission = PLANNING_VIEW): Promise<RunRow & { timezone: string }> {
  const context = officeContextOf(caller)
  const run = isUuid(runId) ? await db.planningRun.findUnique({ where: { id: runId }, select: { ...RUN_COLUMNS, site: { select: { timezone: true } } } }) : null
  assertMayAt(context, permission, run ? { companyId: run.companyId, siteId: run.siteId } : null, 'Planning run')
  const { site, ...row } = run!
  return { ...row, timezone: site.timezone }
}

/** GET /planning/runs/:runId: one run's plan (a superseded or failed one too). */
export async function planOfRun(caller: CommandCaller, runId: string, filter: LinesFilter) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const run = await runFor(caller, db, runId)
    return planOf(db, context, run, run.siteId, run.timezone, filter)
  })
}

/** GET /planning/runs: the run history of the sites the caller may see, newest first. */
export async function listRuns(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly limit?: number | undefined }): Promise<{ runs: RunView[] }> {
  const context = officeContextOf(caller)
  if (query.siteId) await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const rows = await db.planningRun.findMany({
      where: { AND: [scopeWhere(actorOf(context), PLANNING_VIEW, { company: 'companyId', site: 'siteId' }) as object, query.siteId ? { siteId: query.siteId } : {}] },
      select: RUN_COLUMNS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 20,
    })
    const counts = await runCounts(db, rows.map((row) => row.id))
    return { runs: rows.map((row) => runViewOf(row, counts.get(row.id)!)) }
  })
}

// ---- the stock the plan may not use ---------------------------------------------------------------------------------

type StockLineView = {
  item: { id: string; code: string; name: string; baseUom: LineView['uom'] }
  colour: { id: string; code: string; name: string } | null
  lot: { id: string; code: string; qualityStatus: LotRow['qualityStatus']; crViStatus: LotRow['crViStatus']; qualityNote: string | null; receivedAt: string | null; qualityDecidedAt: string | null } | null
  quantity: string
  hides: number
  reason: NotCountedReason | null
  words: string | null
  held: boolean
}

async function stockLinesOf(db: Reader, lines: readonly { entry: PlanStockRow; notCounted: NotCountedReason | null; held: boolean }[], lots: readonly LotRow[]): Promise<StockLineView[]> {
  const itemIds = [...new Set(lines.map((line) => line.entry.itemId))]
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, baseUom: true } })
  const colourIds = [...new Set(lines.flatMap((line) => (line.entry.itemColourId ? [line.entry.itemColourId] : [])))]
  const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })
  const itemOf = new Map(items.map((item) => [item.id, item]))
  const colourOf = new Map(colours.map((colour) => [colour.id, colour]))
  const lotOf = new Map(lots.map((lot) => [lot.id, lot]))
  return lines
    .map((line) => {
      const lot = line.entry.lotId ? lotOf.get(line.entry.lotId) : undefined
      return {
        item: itemOf.get(line.entry.itemId)!,
        colour: line.entry.itemColourId ? (colourOf.get(line.entry.itemColourId) ?? null) : null,
        lot: lot
          ? {
              id: lot.id,
              code: lot.code,
              qualityStatus: lot.qualityStatus,
              crViStatus: lot.crViStatus,
              qualityNote: lot.qualityNote,
              receivedAt: lot.receivedAt ? lot.receivedAt.toISOString() : null,
              qualityDecidedAt: lot.qualityDecidedAt ? lot.qualityDecidedAt.toISOString() : null,
            }
          : null,
        quantity: quantityOf(line.entry.quantity),
        hides: line.entry.hides,
        reason: line.notCounted,
        words: line.notCounted ? NOT_COUNTED_WORDS[line.notCounted] : null,
        held: line.held,
      }
    })
    .sort((a, b) => (a.item.code !== b.item.code ? (a.item.code < b.item.code ? -1 : 1) : (a.lot?.code ?? '') < (b.lot?.code ?? '') ? -1 : (a.lot?.code ?? '') > (b.lot?.code ?? '') ? 1 : 0))
}

/** GET /planning/unusable-stock: stock at the site the plan may not use, each with its reason (now). */
export async function unusableStock(caller: CommandCaller, query: { readonly siteId: string; readonly itemId?: string | undefined }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const stock = await readStock(db, site.id, query.itemId ? [query.itemId] : null)
    const lots = await readLots(db, stock.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))
    const facts = new Map(lots.map((lot) => [lot.id, lotFactsOf(lot)]))
    // Each lot judged on its own colour: only its quality reasons, never "another colour".
    const lines = stock.flatMap((entry) => {
      const netting = netMaterial({ itemColourId: entry.itemColourId, demands: [], stock: [entry], lotOf: (id) => facts.get(id), purchases: [], runDate: todayAt(site.timezone) })
      const line = netting.stock[0]
      return line && line.notCounted ? [{ entry, notCounted: line.notCounted, held: line.held }] : []
    })
    return { siteId: site.id, lines: await stockLinesOf(db, lines, lots) }
  })
}

// ---- why this number ------------------------------------------------------------------------------------------------

/** B-W2a-22: the demand parts of a line as its run pegged them (what each order line, size and work order still needed). */
function partsFromPegging(rows: readonly PegRowRead[], sources: readonly RequirementSource[]): DemandPart[] {
  const parts = new Map<string, { row: PegRowRead; quantity: Decimal }>()
  for (const row of rows) {
    const key = [row.salesOrderLineId ?? '-', row.size ?? '-', row.workOrderId ?? '-'].join('|')
    const entry = parts.get(key)
    parts.set(key, { row: entry?.row ?? row, quantity: (entry?.quantity ?? ZERO).plus(row.quantity.toString()) })
  }
  return [...parts.entries()].map(([key, { row, quantity }]) => {
    const source = sources.find((candidate) => candidate.orderLineId === row.salesOrderLineId)
    return {
      key,
      orderId: source?.orderId ?? '',
      orderNumber: source?.orderNumber ?? '',
      orderLineId: row.salesOrderLineId ?? '',
      lineSeq: source?.lineSeq ?? 0,
      partyId: null,
      size: row.size,
      workOrderId: row.workOrderId,
      workOrderNumber: null,
      pieces: 0,
      dueDate: dayOf(row.demandDate),
      quantity: quantity.toFixed(4),
      issued: '0.0000',
    }
  })
}

/** W1: one source as one part (no work order split). */
const partOfSource = (source: RequirementSource): DemandPart => ({
  key: `${source.orderLineId}|${source.size}|-`,
  orderId: source.orderId,
  orderNumber: source.orderNumber,
  orderLineId: source.orderLineId,
  lineSeq: source.lineSeq,
  partyId: null,
  size: source.size,
  workOrderId: null,
  workOrderNumber: null,
  pieces: source.pieces,
  dueDate: source.dueDate,
  quantity: source.quantity,
  issued: source.issued,
})

/** GET /planning/requirements/:requirementId: the line, its sentence and ladder, and today's stock and purchase lines behind it. */
export async function explainLine(caller: CommandCaller, requirementId: string) {
  const context = officeContextOf(caller)
  const withCost = seesCost(context)
  return caller.withClient(async (db) => {
    const row = isUuid(requirementId) ? await db.materialRequirement.findUnique({ where: { id: requirementId }, select: REQUIREMENT_COLUMNS }) : null
    if (!row) throw new NotFoundError('Requirement not found.')
    const run = await runFor(caller, db, row.runId).catch(() => {
      throw new NotFoundError('Requirement not found.')
    })
    const lineContext = await readLineContext(db, [row], withCost)
    const today = todayAt(run.timezone)
    const line = lineViewOf(row, lineContext, today, withCost)
    const item = lineContext.items.get(row.itemId)!
    const units = unitsOf(item)

    const stock = await readStock(db, row.siteId, [row.itemId])
    const lots = await readLots(db, stock.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))
    const facts = new Map(lots.map((lot) => [lot.id, lotFactsOf(lot)]))
    const purchases = (await readPurchases(db, row.siteId, [row.itemId])).filter((purchase) => purchase.itemColourId === row.itemColourId)
    const sources = sourcesOf(row.sources)
    // B-W2a-22: the line's demand as the run pegged it (per order line, size and work order), netted again with today's
    // stock, reservations and purchase lines; a line of a run without pegging nets its sources (W1).
    const pegRows = await db.requirementPegging.findMany({ where: { requirementId: row.id }, select: PEG_COLUMNS, orderBy: { seq: 'asc' } })
    const reservations = await readReservations(db, row.siteId, [row.itemId])
    const now = pegMaterial({
      itemColourId: row.itemColourId,
      parts: pegRows.length > 0 ? partsFromPegging(pegRows, sources) : sources.map((source) => partOfSource(source)),
      stock,
      lotOf: (id) => facts.get(id),
      reservations,
      purchases,
      runDate: today,
    })
    const sum = (reasons: readonly NotCountedReason[]) => now.stock.filter((entry) => entry.notCounted && reasons.includes(entry.notCounted)).reduce((total, entry) => total.plus(entry.entry.quantity.toString()), ZERO)
    // What the suggestion brings: the net need (a firm planned order is said apart, below).
    const toBring = new Dec(line.netQuantity)
    const companyId = run.companyId
    const sourceOfLine = line.action === 'BUY' && row.supplierId ? sourceFor(lineContext.sources, { companyId, itemId: row.itemId, itemColourId: row.itemColourId }, row.supplierId) : null
    const fromSource = sourceOfLine ? buyFromSource(toBring.toFixed(4), units, sourceOfLine, lineContext.supplierLeadTimes.get(row.supplierId!) ?? null) : null
    const steps = fromSource?.steps ?? suggestionFor(toBring.toFixed(4), line.action, units, line.action === 'BUY' ? lineContext.rulesOf(row.itemId, row.supplierId) : NO_SUPPLY_RULES).steps
    const rounding = new Dec(line.suggestedBaseQuantity).minus(toBring)
    const suggestion = { quantity: line.suggestedQuantity, uom: line.suggestedUom, baseQuantity: line.suggestedBaseQuantity, roundingBase: (rounding.isNegative() ? ZERO : rounding).toFixed(4), steps }
    const words = sentenceOf(line, {
      orders: line.orders.length,
      issued: sources.reduce((total, source) => total.plus(source.issued), ZERO).toFixed(4),
      otherColours: sum(['OTHER_COLOUR']).toFixed(4),
      rejected: sum(['REJECTED']).toFixed(4),
      tooLate: now.purchases.filter((purchase) => purchase.why === 'TOO_LATE').reduce((total, purchase) => total.plus(purchase.notCounted), ZERO).toFixed(4),
      suggestion,
      hides: line.estimatedHides,
      orderBy: line.orderBy ?? { ...orderByOf(line.needDate, NO_SUPPLY_RULES, today) },
    })
    const extra: string[] = []
    if (new Dec(now.reservedForOthers).gt(0)) extra.push(`${quantityWords(now.reservedForOthers, line.uom)} in stock are reserved for other work orders or orders and not counted.`)
    if (line.firm) {
      extra.push(
        `A firm planned order${line.firm.carried ? ' carried from an earlier plan' : ''} brings ${quantityWords(line.firm.quantity, line.firm.uom)}${line.firm.uom === line.uom ? '' : ` (about ${quantityWords(line.firm.baseQuantity, line.uom)})`} by ${line.firm.date}; the plan does not change it, and it is what is bought.`,
      )
    }
    const sentence = [words, ...extra].join(' ')
    const pegging = await pegTreeView(db, pegRows, new Map([[row.id, line.firm !== null]]))
    const byLine = new Map(purchases.map((purchase) => [purchase.purchaseOrderLineId, purchase]))
    const changed =
      now.usable !== line.usableStock || now.held !== line.heldStock || now.onOrder !== line.onOrder || now.net !== line.netQuantity
    return {
      run: runViewOf(run, (await runCounts(db, [run.id])).get(run.id)!),
      line,
      sentence,
      pegging,
      bridge: bridgeOf(line, suggestion),
      rounding: steps.map((step) => ({ ...step })),
      now: {
        reservedForOthers: now.reservedForOthers,
        usableStock: now.usable,
        heldStock: now.held,
        onOrder: now.onOrder,
        netQuantity: now.net,
        changedSinceRun: changed,
        stock: await stockLinesOf(
          db,
          now.stock.map((entry) => ({ entry: { ...entry.entry, itemId: row.itemId } as PlanStockRow, notCounted: entry.notCounted, held: entry.held })),
          lots,
        ),
        purchases: now.purchases.map((purchase) => {
          const read = byLine.get(purchase.line.purchaseOrderLineId)!
          return {
            purchaseOrderId: read.purchaseOrderId,
            purchaseOrderNumber: read.purchaseOrderNumber,
            purchaseOrderStatus: read.purchaseOrderStatus,
            purchaseOrderLineId: read.purchaseOrderLineId,
            seq: read.seq,
            openQuantity: quantityOf(read.openQuantity),
            dueDate: read.dueDate,
            confirmed: read.confirmed,
            counted: purchase.counted,
            notCounted: purchase.notCounted,
            why: purchase.why,
          }
        }),
      },
    }
  })
}

// ---- decisions --------------------------------------------------------------------------------------------------------

interface LineRef {
  readonly id: string
  readonly version: number
}

async function decide(caller: CommandCaller, refs: readonly LineRef[], to: 'IGNORED' | 'OPEN', note: string | null, idempotencyKey: string | undefined) {
  const context = officeContextOf(caller)
  const ids = refs.map((ref) => ref.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A line is named twice.', [{ path: 'body/lines', message: 'Name each line once.' }])
  const rows = await caller.withClient((db) => db.materialRequirement.findMany({ where: { id: { in: ids } }, select: { id: true, runId: true } }))
  const runIds = [...new Set(rows.map((row) => row.runId))]
  if (rows.length !== ids.length || runIds.length !== 1) {
    if (rows.length === ids.length) throw new ValidationError('The lines are of different plans.', [{ path: 'body/lines', message: 'Decide the lines of one plan at a time.' }])
    throw new NotFoundError('Requirement not found.')
  }
  const run = await caller.withClient((db) => runFor(caller, db, runIds[0]!, PLANNING_DECIDE).catch((error: unknown) => {
    throw error instanceof NotFoundError ? new NotFoundError('Requirement not found.') : error
  }))
  const { result, replayed } = await command(
    caller,
    { name: to === 'IGNORED' ? 'planning.setAside' : 'planning.reopen', idempotencyKey, input: { lines: refs, note }, record: { type: 'PlanningRun', id: run.id } },
    async (tools) => {
      const current = await tools.tx.planningRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } })
      const lines: LineRef[] = []
      for (const ref of refs) {
        const line = await tools.tx.materialRequirement.findUniqueOrThrow({ where: { id: ref.id }, select: { decision: true, action: true, version: true, decisionNote: true } })
        const problem = decisionProblem(line, current.status, to)
        if (problem) throw new ConflictError(problem)
        const data = to === 'IGNORED' ? { decision: to, decisionNote: note, decidedAt: tools.now, decidedById: context.actorId } : { decision: to, decisionNote: null, decidedAt: null, decidedById: null }
        const { count } = await tools.tx.materialRequirement.updateMany({ where: { id: ref.id, version: ref.version }, data: { ...data, version: ref.version + 1 } })
        if (count !== 1) throw new StaleVersionError('MaterialRequirement', ref.id, line.version, ref.version)
        tools.audit({
          recordType: 'MaterialRequirement',
          recordId: ref.id,
          companyId: run.companyId,
          siteId: run.siteId,
          before: { decision: line.decision, decisionNote: line.decisionNote },
          after: { decision: to, decisionNote: data.decisionNote },
        })
        lines.push({ id: ref.id, version: ref.version + 1 })
      }
      tools.emit({ type: 'planning.requirements_decided', subject: run.id, companyId: run.companyId, siteId: run.siteId, payload: { runId: run.id, siteId: run.siteId, decision: to, requirementIds: ids } })
      return { runId: run.id, decision: to, lines }
    },
  )
  return { ...result, replayed }
}

/** POST /planning/requirements/set-aside: lines of the latest plan set aside with a reason. */
export function setAside(caller: CommandCaller, body: { readonly lines: readonly LineRef[]; readonly reason: SetAsideReason; readonly note?: string | undefined }, idempotencyKey?: string) {
  const problems = setAsideProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  return decide(caller, body.lines, 'IGNORED', decisionNoteOf(body.reason, body.note), idempotencyKey)
}

/** POST /planning/requirements/reopen: set-aside lines opened again (the Undo). */
export function reopen(caller: CommandCaller, body: { readonly lines: readonly LineRef[] }, idempotencyKey?: string) {
  return decide(caller, body.lines, 'OPEN', null, idempotencyKey)
}

export type { RequirementRow }
