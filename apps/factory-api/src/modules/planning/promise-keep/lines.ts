import type { Prisma } from '@nexus/factory-db'
import type { GateMarket } from '@nexus/factory-domain/compliance/gates/gate'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { MADE_WORK_ORDER_STATUSES, OPEN_WORK_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import { demandOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import { lineHistoryOf, sizeHistoryOf, sizeTimeline, slippedBetween } from '@nexus/factory-domain/planning/promise-keep/history'
import { finishWithMaterial, monthOf, PROMISE_TILES, riskOf, riskRank, riskWords, slackDays, worstRisk, type FinishSource, type PromiseTile, type RiskState } from '@nexus/factory-domain/planning/promise-keep/risk'
import { PLANNING_PROMISE_MANAGE, PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import type { SizeState } from '@nexus/factory-domain/planning/promise/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { countryOf } from '../../compliance/gates/facts'
import { officeContextOf } from '../access'
import { backlogPositions } from '../backlog/backlog'
import { scheduleWorld } from '../schedule/service'
import { materialStartsOf } from '../schedule-depth/material'
import { certificatesOn, marketFor, type SizeCertificate } from '../promise/certificates'
import { answerPromises, type PromiseAsk } from '../promise/engine'
import { whereOf } from '../promise/read'
// B-W2b-F44: a garment still to make is never planned to finish today (the site's next working day at the earliest).
import { firstMakeDayOf } from '../promise/read'
import { mayPromiseAt, promiseSite, readPromiseRows } from '../promise/store'
import { dayOf, type Reader, type SiteRow } from '../store'
import { customerOf, KEEP_LINE_SELECT, KEEP_ORDER_STATUSES, originalOf, readProposals, shippedOfLines, sizesOfLine, typedOf, type KeepLine } from './store'

/**
 * Orders at risk and the promise history in a list (B-W2b-317; PLN-173, PLN-174; design planning.promise › tiles "At risk ·
 * Slipped this month · Re-promise waiting for sales · No valid certificate through ship date", › lines "Customer, order,
 * style, sizes · First promise (kept forever) · Current promise · Planned finish (from the board) · Slack days · Risk ·
 * Certificate cover · Changes: count of slips"). Read with planning.promise.view over the site; each line also with
 * orders.view over its order. No money, no person.
 *
 * The open lines of the site (a line without a making site belongs to the company's only plant), of orders a promise may
 * still be recorded on, not closed short. Per size: ordered, shipped, open; its first promise (kept forever), its promise
 * now (B-W2b-301's rule), and the day the plan says it is ready (factory-domain planning/promise-keep/risk): stock ready now,
 * each open work order at the board's planned finish (its due date off the board) moved later by the days its material
 * comes after its planned start (B-W2b-312's material day: a late supplier date replans what it feeds, PLN-200), the
 * plan's planned work orders, and the promise engine for what nothing makes yet — asked for every line at once in the
 * ranked backlog's order (PLN-177), so the first order takes the first free capacity. The certificate on the size's
 * promised day (PLN-179). The line: the worst size's risk, its latest dates (ship complete), its changes and slips.
 *
 * B-W2b-F44 (Owner 2026-11-13, option A): garments still to make (an open work order, a planned order, the engine's) never
 * finish before the site's next working day; only stock ready now finishes today.
 */

export const LINES_LIMIT = 300

export interface LinesFilter {
  readonly orderLineIds?: readonly string[] | undefined
  readonly partyId?: string | undefined
  readonly styleId?: string | undefined
  readonly q?: string | undefined
  readonly limit?: number | undefined
}

const max0 = (value: number): number => (value > 0 ? value : 0)
const latest = (dates: readonly (BusinessDate | null)[]): BusinessDate | null => dates.reduce<BusinessDate | null>((best, date) => (date === null ? best : best === null || date > best ? date : best), null)

interface WorkOrderFinish {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly dueDate: BusinessDate | null
  readonly plannedFinish: BusinessDate | null
  readonly materialStart: BusinessDate | null
  readonly materialState: string | null
  readonly delayDays: number
  readonly finish: BusinessDate | null
  readonly source: FinishSource
  readonly words: string | null
}

/** Per open work order: where the board finishes it, and when its material lets it finish (B-W2b-F44: never before `firstMakeDay`). */
async function workOrderFinishes(db: Reader, site: SiteRow, ids: readonly string[], dueOf: ReadonlyMap<string, BusinessDate | null>, today: BusinessDate, now: Date, firstMakeDay: BusinessDate): Promise<Map<string, WorkOrderFinish>> {
  const out = new Map<string, WorkOrderFinish>()
  if (ids.length === 0) return out
  const world = await scheduleWorld(db, site, { from: today, to: today }, now)
  const known = ids.filter((id) => world.workOrders.some((workOrder) => workOrder.id === id))
  const starts = known.length > 0 ? await materialStartsOf(db, world, known) : new Map()
  const dayIn = (ms: number | null | undefined): BusinessDate | null => (ms === null || ms === undefined ? null : businessDate(new Date(ms), site.timezone))
  for (const id of ids) {
    const workOrder = world.workOrders.find((entry) => entry.id === id)
    const schedule = world.schedules.get(id)
    const plannedFinish = dayIn(schedule?.plannedFinish)
    const plannedStart = dayIn(schedule?.plannedStart)
    const dueDate = dueOf.get(id) ?? null
    const start = starts.get(id) ?? null
    const notCovered = start?.state === 'NOT_COVERED'
    const base = plannedFinish ?? dueDate
    let finish: BusinessDate | null
    let delayDays = 0
    if (plannedFinish !== null) {
      const moved = finishWithMaterial({ plannedStart, plannedFinish, materialStart: start?.startDay ?? null, notCovered })
      finish = moved.finish
      delayDays = moved.delayDays
    } else {
      // Off the board: its due date, and never before its material lets it start.
      finish = notCovered ? null : latest([base, start?.startDay ?? null])
      delayDays = base !== null && finish !== null && finish > base ? Math.round((Date.parse(`${finish}T00:00:00Z`) - Date.parse(`${base}T00:00:00Z`)) / 86_400_000) : 0
    }
    out.set(id, {
      id,
      number: workOrder?.number ?? '',
      status: workOrder?.status ?? '',
      dueDate,
      plannedFinish,
      materialStart: start?.startDay ?? null,
      materialState: start?.state ?? null,
      delayDays,
      finish: finish !== null && finish < firstMakeDay ? firstMakeDay : finish, // B-W2b-F44: still to make, never today
      source: plannedFinish !== null ? 'BOARD' : 'WORK_ORDER_DUE',
      words: start && (delayDays > 0 || notCovered) ? start.words : null,
    })
  }
  return out
}

export interface PromiseLineSize {
  readonly size: string | null
  readonly ordered: number
  readonly shipped: number
  readonly open: number
  readonly first: BusinessDate | null
  readonly current: BusinessDate | null
  readonly currentSource: 'RECORD' | 'TYPED' | null
  readonly finish: BusinessDate | null
  readonly finishSource: FinishSource
  readonly slackDays: number | null
  readonly risk: RiskState | null
  readonly certificate: { readonly state: SizeCertificate['state']; readonly certificate: string | null; readonly validTo: BusinessDate | null; readonly words: string } | null
  readonly workOrders: { readonly id: string; readonly number: string; readonly status: string; readonly pieces: number; readonly plannedFinish: BusinessDate | null; readonly materialStart: BusinessDate | null; readonly delayDays: number; readonly finish: BusinessDate | null; readonly words: string | null }[]
  readonly engine: { readonly state: SizeState; readonly date: BusinessDate | null } | null
  readonly words: string
}

/** The site's open lines with their promises, planned finish and risk (the list, and the lines a late supply feeds). */
export async function promiseLinesOf(db: Reader, context: OfficeContext, site: SiteRow, now: Date, filter: LinesFilter = {}) {
  const today = businessDate(now, site.timezone)
  const plants = await db.site.count({ where: { companyId: site.companyId, kind: 'PLANT', status: 'ACTIVE' } })
  const onlyPlant = plants === 1 && site.kind === 'PLANT' && site.status === 'ACTIVE'
  const q = filter.q?.trim()
  const limit = Math.min(filter.limit ?? LINES_LIMIT, LINES_LIMIT)
  const where: Prisma.SalesOrderLineWhereInput = {
    AND: [
      { companyId: site.companyId, kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] }, closedShortAt: null, order: { status: { in: [...KEEP_ORDER_STATUSES] } } },
      onlyPlant ? { OR: [{ siteId: site.id }, { siteId: null }] } : { siteId: site.id },
      scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderLineWhereInput,
      ...(filter.orderLineIds ? [{ id: { in: [...filter.orderLineIds] } }] : []),
      ...(filter.partyId ? [{ partyId: filter.partyId }] : []),
      ...(filter.styleId ? [{ styleId: filter.styleId }] : []),
      ...(q ? [{ OR: [{ order: { number: { contains: q, mode: 'insensitive' as const } } }, { style: { code: { contains: q, mode: 'insensitive' as const } } }, { order: { party: { legalName: { contains: q, mode: 'insensitive' as const } } } }, { order: { party: { tradeName: { contains: q, mode: 'insensitive' as const } } } }, { order: { party: { code: { contains: q, mode: 'insensitive' as const } } } }] }] : []),
    ],
  }
  const read = await db.salesOrderLine.findMany({ where, select: KEEP_LINE_SELECT, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }], take: limit + 1 })
  const complete = read.length <= limit
  const lines = read.slice(0, limit)
  if (lines.length === 0) return { today, lines: [] as ReturnType<typeof lineViewOf>[], complete }
  const lineIds = lines.map((line) => line.id)
  const firstMakeDay = await firstMakeDayOf(db, site, today) // B-W2b-F44
  const shipped = await shippedOfLines(db, lineIds)
  const promiseRows = await readPromiseRows(db, lineIds)

  // What makes the lines: work order cells (open and made), the plan's planned work orders.
  const cells = await db.workOrderSize.findMany({
    where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' }, status: { in: [...OPEN_WORK_ORDER_STATUSES, ...MADE_WORK_ORDER_STATUSES] } } },
    select: { workOrderId: true, salesOrderLineId: true, size: true, quantity: true, workOrder: { select: { status: true, dueDate: true } } },
    orderBy: [{ workOrderId: 'asc' }, { size: 'asc' }],
  })
  const isOpen = (status: string) => (OPEN_WORK_ORDER_STATUSES as readonly string[]).includes(status)
  const dueOf = new Map(cells.map((cell) => [cell.workOrderId, cell.workOrder.dueDate ? dayOf(cell.workOrder.dueDate) : null]))
  const finishes = await workOrderFinishes(db, site, [...new Set(cells.filter((cell) => isOpen(cell.workOrder.status)).map((cell) => cell.workOrderId))], dueOf, today, now, firstMakeDay /* B-W2b-F44 */)
  const styleIds = [...new Set(lines.map((line) => line.styleId))]
  const planned = await db.plannedWorkOrder.findMany({ where: { siteId: site.id, status: 'PLANNED', styleId: { in: styleIds } }, select: { id: true, demand: true, dueDate: true }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })
  const plannedFor = (lineId: string, size: string | null) =>
    planned.flatMap((row) => {
      const pieces = demandOf(row.demand)
        .filter((entry) => entry.orderLineId === lineId && (size === null || entry.size === size))
        .reduce((sum, entry) => sum + entry.pieces, 0)
      return pieces > 0 ? [{ id: row.id, pieces, dueDate: dayOf(row.dueDate) }] : []
    })

  // Per line and size: what is open and what makes it.
  const askSize = (line: KeepLine, size: string | null) => size ?? line.baseSize ?? line.style.baseSize ?? line.style.sizes[0] ?? ''
  const facts = lines.map((line) => {
    const sizes = sizesOfLine(line).map((entry) => {
      const ofSize = cells.filter((cell) => cell.salesOrderLineId === line.id && (entry.size === null || cell.size === entry.size))
      const made = ofSize.filter((cell) => !isOpen(cell.workOrder.status)).reduce((sum, cell) => sum + cell.quantity, 0)
      const shippedPieces = shipped(line.id, entry.size)
      const open = max0(entry.ordered - shippedPieces)
      const workOrders = ofSize.filter((cell) => isOpen(cell.workOrder.status)).map((cell) => ({ pieces: cell.quantity, ...finishes.get(cell.workOrderId)! }))
      const plannedOrders = plannedFor(line.id, entry.size)
      const readyNow = max0(made - shippedPieces)
      const covered = readyNow + workOrders.reduce((sum, row) => sum + row.pieces, 0) + plannedOrders.reduce((sum, row) => sum + row.pieces, 0)
      return { ...entry, shipped: shippedPieces, open, readyNow, workOrders, plannedOrders, uncovered: max0(open - covered) }
    })
    return { line, sizes, country: countryOf(line.order.shipTo) }
  })

  // The promise engine for what nothing makes yet, every line at once in the ranked backlog's order (per destination).
  const positions = await backlogPositions(db, site.companyId)
  const position = (line: KeepLine) => positions.get(line.orderId) ?? Number.MAX_SAFE_INTEGER
  const engineOf = new Map<string, { state: SizeState; date: BusinessDate | null }>()
  const byCountry = new Map<string | null, typeof facts>()
  for (const entry of [...facts].sort((a, b) => position(a.line) - position(b.line) || (a.line.order.number < b.line.order.number ? -1 : a.line.order.number > b.line.order.number ? 1 : a.line.seq - b.line.seq))) {
    if (!entry.sizes.some((size) => size.uncovered > 0)) continue
    byCountry.set(entry.country, [...(byCountry.get(entry.country) ?? []), entry])
  }
  for (const [country, group] of byCountry) {
    const { where: asked } = await whereOf(db, site, now, country)
    const asks: PromiseAsk[] = group.map(({ line, sizes }) => ({
      key: line.id,
      orderLineId: line.id,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      revisionId: line.styleRevisionId,
      sizes: sizes.filter((size) => size.uncovered > 0).map((size) => ({ size: askSize(line, size.size), quantity: size.uncovered })),
      madeToMeasure: line.kind === 'MADE_TO_MEASURE',
      wantedDate: null,
    }))
    for (const answer of await answerPromises(db, asked, asks)) {
      for (const size of answer.sizes) engineOf.set(`${answer.key}|${size.size}`, { state: size.state, date: size.date ?? size.readyDate })
    }
  }

  // The certificate on each size's promised day (PLN-179), per destination.
  const markets = new Map<string | null, { market: GateMarket | null; destination: string | null }>()
  const marketOf = async (country: string | null) => {
    if (!markets.has(country)) markets.set(country, await marketFor(db, country))
    return markets.get(country)!
  }
  const certificateOf = new Map<string, SizeCertificate>()
  for (const { line, sizes, country } of facts) {
    const typed = typedOf(line)
    const rows = promiseRows.get(line.id) ?? []
    const days = new Map<BusinessDate, string[]>()
    for (const size of sizes) {
      if (size.open <= 0) continue
      const current = sizeHistoryOf(size.size, rows, typed, originalOf(line)).current
      if (!current) continue
      const day = current.date < today ? today : current.date
      days.set(day, [...(days.get(day) ?? []), askSize(line, size.size)])
    }
    const market = await marketOf(country)
    for (const [day, asked] of days) {
      const answers = await certificatesOn(db, { styleId: line.styleId, styleCode: line.style.code, asks: asked.map((size) => ({ key: size, colourwayId: line.colourwayId, colourwayCode: line.colourway.code, size })), market: market.market, destination: market.destination, day, now })
      for (const [key, answer] of answers) certificateOf.set(`${line.id}|${key}`, answer)
    }
  }

  const proposals = await readProposals(db, [...new Set(lines.map((line) => line.orderId))])
  const month = monthOf(today)
  const monthFrom = businessDayStart(month.from, site.timezone)
  const monthTo = businessDayStart(month.to, site.timezone)
  const mayRepromise = mayPromiseAt(context, PLANNING_PROMISE_MANAGE, site)

  const views = facts.map(({ line, sizes }) =>
    lineViewOf({ line, sizes, rows: promiseRows.get(line.id) ?? [], today, firstMakeDay /* B-W2b-F44 */, engineOf, certificateOf, askSize, waiting: proposals.find((proposal) => proposal.orderLineId === line.id && proposal.state === 'WAITING') ?? null, monthFrom, monthTo, position: positions.get(line.orderId) ?? null, mayRepromise }),
  )
  return { today, lines: views, complete }
}

function lineViewOf(input: {
  line: KeepLine
  sizes: { size: string | null; ordered: number; shipped: number; open: number; readyNow: number; uncovered: number; workOrders: (WorkOrderFinish & { pieces: number })[]; plannedOrders: { id: string; pieces: number; dueDate: BusinessDate }[] }[]
  rows: Parameters<typeof sizeTimeline>[1]
  today: BusinessDate
  /** B-W2b-F44: the site's next working day: a planned order's garments, still to make, never finish before it. */
  firstMakeDay: BusinessDate
  engineOf: ReadonlyMap<string, { state: SizeState; date: BusinessDate | null }>
  certificateOf: ReadonlyMap<string, SizeCertificate>
  askSize: (line: KeepLine, size: string | null) => string
  waiting: Awaited<ReturnType<typeof readProposals>>[number] | null
  monthFrom: Date
  monthTo: Date
  position: number | null
  mayRepromise: boolean
}) {
  const { line, rows, today } = input
  const typed = typedOf(line)
  const original = originalOf(line)
  const sizeViews: PromiseLineSize[] = input.sizes.map((entry) => {
    const history = sizeHistoryOf(entry.size, rows, typed, original)
    const engine = entry.uncovered > 0 ? (input.engineOf.get(`${line.id}|${input.askSize(line, entry.size)}`) ?? null) : null
    const candidates: { date: BusinessDate | null; source: FinishSource }[] = [
      ...(entry.readyNow > 0 ? [{ date: today, source: 'STOCK' as FinishSource }] : []),
      ...entry.workOrders.map((row) => ({ date: row.finish, source: row.source })),
      ...entry.plannedOrders.map((row) => ({ date: row.dueDate < input.firstMakeDay ? input.firstMakeDay : row.dueDate, source: 'PLANNED_ORDER' as FinishSource })), // B-W2b-F44
      ...(entry.uncovered > 0 ? [{ date: engine?.date ?? null, source: 'CAPABLE' as FinishSource }] : []),
    ]
    const unknown = candidates.some((candidate) => candidate.date === null)
    const known = candidates.filter((candidate) => candidate.date !== null)
    const setBy = known.reduce<{ date: BusinessDate | null; source: FinishSource } | null>((best, candidate) => (best === null || candidate.date! > best.date! ? candidate : best), null)
    const finish = entry.open === 0 || unknown ? null : (setBy?.date ?? null)
    const finishSource: FinishSource = entry.open === 0 ? 'NONE' : unknown ? (candidates.find((candidate) => candidate.date === null)?.source ?? 'NONE') : (setBy?.source ?? 'NONE')
    const certificate = input.certificateOf.get(`${line.id}|${input.askSize(line, entry.size)}`) ?? null
    const current = history.current?.date ?? null
    const risk = riskOf({ open: entry.open, promise: current, finish, today })
    const label = entry.size === null ? 'The unit' : `Size ${entry.size}`
    return {
      size: entry.size,
      ordered: entry.ordered,
      shipped: entry.shipped,
      open: entry.open,
      first: history.first?.date ?? null,
      current,
      currentSource: history.current?.source ?? null,
      finish,
      finishSource,
      slackDays: entry.open === 0 ? null : slackDays(current, finish),
      risk,
      certificate: certificate ? { state: certificate.state, certificate: certificate.certificate, validTo: certificate.validTo, words: certificate.words } : null,
      workOrders: entry.workOrders.map((row) => ({ id: row.id, number: row.number, status: row.status, pieces: row.pieces, plannedFinish: row.plannedFinish, materialStart: row.materialStart, delayDays: row.delayDays, finish: row.finish, words: row.words })),
      engine,
      words: riskWords({ risk, promise: current, finish, today, label }),
    }
  })
  const open = sizeViews.filter((size) => size.open > 0)
  const history = lineHistoryOf(
    sizeViews.map((size) => size.size),
    rows,
    typed,
    original,
  )
  const risk = worstRisk(open.map((size) => size.risk))
  const current = latest(open.map((size) => size.current))
  const unknownFinish = open.some((size) => size.finish === null)
  const finish = unknownFinish ? null : latest(open.map((size) => size.finish))
  const finishSource = open.length === 0 ? 'NONE' : unknownFinish ? (open.find((size) => size.finish === null)?.finishSource ?? 'NONE') : (open.find((size) => size.finish === finish)?.finishSource ?? 'NONE')
  const certificates = open.flatMap((size) => (size.certificate ? [size.certificate] : []))
  const missing = certificates.find((entry) => entry.state === 'MISSING') ?? null
  const validTo = certificates.reduce<BusinessDate | null>((best, entry) => (entry.validTo !== null && (best === null || entry.validTo < best) ? entry.validTo : best), null)
  const slipped = open.some((size) => slippedBetween(sizeTimeline(size.size, rows), input.monthFrom, input.monthTo))
  const tiles: PromiseTile[] = PROMISE_TILES.filter((tile) =>
    tile === 'AT_RISK' ? risk === 'AT_RISK' || risk === 'LATE' : tile === 'SLIPPED_THIS_MONTH' ? slipped : tile === 'REPROMISE_WAITING' ? input.waiting !== null : missing !== null,
  )
  const label = `${line.order.number} line ${line.seq}`
  return {
    id: line.id,
    seq: line.seq,
    kind: line.kind,
    order: { id: line.order.id, number: line.order.number, status: line.order.status, priorityLevel: line.order.priorityLevel, backlogPosition: input.position },
    customer: customerOf(line.order.party),
    style: { id: line.style.id, code: line.style.code, name: line.style.name },
    colourway: { id: line.colourway.id, code: line.colourway.code, name: line.colourway.name },
    sizes: sizeViews,
    first: history.first,
    current,
    finish,
    finishSource,
    slackDays: slackDays(current, finish),
    risk,
    certificate: certificates.length === 0 ? null : { state: missing ? ('MISSING' as const) : (certificates.find((entry) => entry.state === 'EXPIRING')?.state ?? certificates[0]!.state), validTo, words: missing?.words ?? certificates[0]!.words },
    changes: { count: history.changes, slips: history.slips, lastChangeAt: history.lastChangeAt ? toUtcIso(history.lastChangeAt) : null },
    waiting: input.waiting ? { proposalId: input.waiting.id, proposedAt: toUtcIso(input.waiting.proposedAt), sizes: input.waiting.sizes } : null,
    tiles,
    may: { repromise: input.mayRepromise && input.waiting === null && open.length > 0 },
    words: riskWords({ risk, promise: current, finish, today, label }),
  }
}
export type PromiseLineView = ReturnType<typeof lineViewOf>

export interface PromiseListQuery extends Omit<LinesFilter, 'orderLineIds'> {
  readonly siteId: string
  readonly tile?: PromiseTile | undefined
  readonly risk?: RiskState | undefined
}

/** GET /planning/promises — the open order lines with their promise against the planned finish, and the tiles. */
export async function listPromises(caller: CommandCaller, query: PromiseListQuery) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const site = await promiseSite(caller, query.siteId, PLANNING_PROMISE_VIEW, db)
    if (query.partyId && !(await db.party.findUnique({ where: { id: query.partyId }, select: { id: true } }))) throw new ValidationError('No such customer.', [{ path: 'querystring/partyId', message: 'Name a customer.' }])
    const now = serverClock.now()
    const { today, lines, complete } = await promiseLinesOf(db, context, site, now, query)
    const tiles = Object.fromEntries(PROMISE_TILES.map((tile) => [tile, lines.filter((line) => line.tiles.includes(tile)).length])) as Record<PromiseTile, number>
    const counts = { LATE: 0, AT_RISK: 0, NOT_PROMISED: 0, ON_TIME: 0 } as Record<RiskState, number>
    for (const line of lines) if (line.risk) counts[line.risk] += 1
    const shown = lines
      .filter((line) => (query.tile ? line.tiles.includes(query.tile) : true) && (query.risk ? line.risk === query.risk : true))
      .sort(
        (a, b) =>
          riskRank(a.risk) - riskRank(b.risk) ||
          (a.slackDays ?? Number.MIN_SAFE_INTEGER) - (b.slackDays ?? Number.MIN_SAFE_INTEGER) ||
          (a.order.backlogPosition ?? Number.MAX_SAFE_INTEGER) - (b.order.backlogPosition ?? Number.MAX_SAFE_INTEGER) ||
          (a.order.number < b.order.number ? -1 : a.order.number > b.order.number ? 1 : a.seq - b.seq),
      )
    return {
      site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name },
      today,
      asOf: toUtcIso(now),
      tiles,
      counts,
      complete,
      lines: shown,
      words: `${tiles.AT_RISK} at risk, ${tiles.SLIPPED_THIS_MONTH} slipped this month, ${tiles.REPROMISE_WAITING} re-promise${tiles.REPROMISE_WAITING === 1 ? '' : 's'} waiting for sales, ${tiles.NO_CERTIFICATE} without a valid certificate through the promised day.`,
    }
  })
}
