import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { fixedRatio, type Uom } from '@nexus/factory-domain/product/units/units'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { cellProgress, type PlannedPart } from '@nexus/factory-domain/production/cutting/rules'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { workOrderYieldOf } from '../yield/views'
import type { CUT_STATES, CUT_VIEWS } from './contract'
import { liveOf, readCells, readEntries, readPieces, readPlannedParts, readStations, type CellRow, type EntryRow, type Reader } from './store'

/**
 * The cutting office (B-W2a-60; design production.cutting, SCR-238; MES-056, MES-057): one cut per work order whose parts
 * are cut from hides — W2a has no cut order of its own (a cut order that groups work orders comes with fabric lays,
 * MES-034, W2b) — with where it stands (waiting, cutting, cut, held), its leathers and shade lots, garments and pieces
 * planned and cut, the hides and area its live entries used, the hides allocated to it, its yield against the plan, the
 * tables it was cut at and its open recuts; and the tiles (waiting, cutting, held, pieces, hides and area cut today).
 * Office only, with production.cutting.view over the work orders' companies and sites. Per work order, table and lot:
 * never who cut (Statuto dei Lavoratori art. 4; SCM-255). No money.
 */

type CutState = (typeof CUT_STATES)[number]
type CutView = (typeof CUT_VIEWS)[number]

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const unique = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]
const text = (value: Decimal) => quantityText(value.toString())
const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)

/** The statuses each view reads (a cut belongs to a released work order; a completed one only counts as cut). */
const STATUSES: Readonly<Record<CutView, readonly WorkOrderStatus[]>> = {
  open: ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'],
  waiting: ['RELEASED', 'IN_PROGRESS'],
  cutting: ['RELEASED', 'IN_PROGRESS'],
  cut: ['RELEASED', 'IN_PROGRESS', 'COMPLETED'],
  held: ['ON_HOLD'],
  all: ['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'],
}
const IN_VIEW: Readonly<Record<CutView, readonly CutState[]>> = {
  open: ['WAITING', 'CUTTING', 'HELD'],
  waiting: ['WAITING'],
  cutting: ['CUTTING'],
  cut: ['CUT'],
  held: ['HELD'],
  all: ['WAITING', 'CUTTING', 'CUT', 'HELD'],
}
/** At most this many work orders are weighed for one answer (the tiles and the page). */
const CANDIDATES = 300

/**
 * Where a work order's cutting stands: HELD while it is ON_HOLD; CUT when it is completed or every cell with hide-cut
 * parts has all its garments cut; WAITING while no live entry cut anything; else CUTTING.
 */
export function cutStateOf(status: WorkOrderStatus, progress: readonly { readonly toCut: number | null }[], liveEntries: number): CutState {
  if (status === 'ON_HOLD') return 'HELD'
  const counted = progress.filter((cell) => cell.toCut !== null)
  if (status === 'COMPLETED' || (counted.length > 0 && counted.every((cell) => cell.toCut === 0))) return 'CUT'
  return liveEntries === 0 ? 'WAITING' : 'CUTTING'
}

interface Weighed {
  readonly workOrder: Prisma.WorkOrderGetPayload<{ select: typeof HEADER }>
  readonly planned: PlannedPart[]
  readonly cells: CellRow[]
  readonly live: EntryRow[]
  readonly all: EntryRow[]
  readonly progress: ReturnType<typeof cellProgress>
  readonly pieces: Awaited<ReturnType<typeof readPieces>>
  readonly state: CutState
}

const HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  batchNumber: true,
  status: true,
  styleId: true,
  styleRevisionId: true,
  dueDate: true,
  priority: true,
  holdReason: true,
} as const satisfies Prisma.WorkOrderSelect

export interface CutsQuery {
  readonly siteId?: string | undefined
  readonly view: CutView
  readonly q?: string | undefined
  readonly limit: number
}

/** GET /production/cutting/cuts: the cuts of the view (most urgent first, at most `limit`), with the tiles of the scope. */
export async function cutsList(caller: CommandCaller, query: CutsQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput
  const q = query.q?.trim()
  const search: Prisma.WorkOrderWhereInput = q
    ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { batchNumber: { contains: q, mode: 'insensitive' } }, { style: { is: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } } }] }
    : {}
  const site: Prisma.WorkOrderWhereInput = query.siteId ? { siteId: query.siteId } : {}
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    // The tiles weigh every open cut of the scope; the page weighs its view's.
    const statuses = [...new Set([...STATUSES.open, ...STATUSES[query.view]])]
    const orders = await db.workOrder.findMany({
      where: { AND: [scope, site, search, { status: { in: [...statuses] } }] },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }],
      take: CANDIDATES,
      select: HEADER,
    })
    const weighed: Weighed[] = []
    for (const workOrder of orders) {
      const planned = await readPlannedParts(db, workOrder.id)
      if (planned.length === 0) continue
      const cells = await readCells(db, workOrder.id, workOrder.styleId)
      const entries = await readEntries(db, workOrder.id)
      const live = liveOf(entries)
      const pieces = await readPieces(db, live.map((entry) => entry.id))
      const progress = cellProgress(cells, planned, pieces)
      weighed.push({ workOrder, planned, cells, live, all: entries.entries, progress, pieces, state: cutStateOf(workOrder.status, progress, live.length) })
    }
    const inView = weighed.filter((row) => STATUSES[query.view].includes(row.workOrder.status) && IN_VIEW[query.view].includes(row.state))
    const page = inView.slice(0, query.limit)
    const open = weighed.filter((row) => STATUSES.open.includes(row.workOrder.status))
    return {
      cuts: await rowsOf(db, page),
      more: inView.length > page.length,
      tiles: {
        waiting: open.filter((row) => row.state === 'WAITING').length,
        cutting: open.filter((row) => row.state === 'CUTTING').length,
        held: open.filter((row) => row.state === 'HELD').length,
        ...(await today(db, scope, site, now)),
      },
      asOf: toUtcIso(now),
    }
  })
}

async function rowsOf(db: Reader, page: readonly Weighed[]) {
  const workOrderIds = page.map((row) => row.workOrder.id)
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(page.map((row) => row.workOrder.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(page.flatMap((row) => row.planned.map((part) => part.itemId))) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique(page.flatMap((row) => row.planned.map((part) => part.itemColourId))) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(page.flatMap((row) => row.live.map((entry) => entry.lotId))) } }, select: { id: true, code: true, dyeBatch: true } })).map((row) => [row.id, row]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(page.flatMap((row) => row.live.map((entry) => entry.hideId))) } }, select: { id: true, itemId: true } })).map((row) => [row.id, row]))
  const stations = await readStations(db, unique(page.flatMap((row) => row.live.map((entry) => entry.stationId))))
  const allocated = await db.reservation.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: workOrderIds }, status: 'ACTIVE', hideId: { not: null } }, _count: { _all: true } })
  const allocatedOf = new Map(allocated.map((row) => [row.workOrderId!, row._count._all]))
  const recuts = await db.replacementRequest.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: workOrderIds }, kind: 'RECUT', status: 'OPEN' }, _count: { _all: true } })
  const recutsOf = new Map(recuts.map((row) => [row.workOrderId, row._count._all]))
  const rows = []
  for (const row of page) {
    const { workOrder } = row
    const counted = row.progress.filter((cell) => cell.cut !== null)
    const garmentsPlanned = counted.reduce((sum, cell) => sum + cell.quantity, 0)
    const garmentsCut = counted.reduce((sum, cell) => sum + (cell.cut ?? 0), 0)
    const piecesPlanned = row.cells.reduce((sum, cell) => sum + cell.quantity * new Set(row.planned.filter((part) => part.cellId === cell.id).map((part) => part.part)).size, 0)
    // Area used per unit (a leather's base unit): never added across units.
    const used = new Map<string, Decimal>()
    for (const entry of row.live) {
      const uom = items.get(hides.get(entry.hideId)?.itemId ?? '')?.baseUom ?? 'FT2'
      used.set(uom, (used.get(uom) ?? ZERO).plus(entry.baseAreaUsed.toString()))
    }
    const figures = await workOrderYieldOf(db, workOrder)
    const materials = new Map<string, { itemId: string; itemColourId: string | null; code: string; name: string; baseUom: string; colourCode: string | null }>()
    for (const part of row.planned) {
      const item = items.get(part.itemId)
      materials.set(`${part.itemId}|${part.itemColourId ?? '-'}`, { itemId: part.itemId, itemColourId: part.itemColourId, code: item?.code ?? '', name: item?.name ?? '', baseUom: item?.baseUom ?? 'FT2', colourCode: part.itemColourId ? (colours.get(part.itemColourId) ?? null) : null })
    }
    const last = row.all.reduce<Date | null>((latest, entry) => (latest === null || entry.serverTime > latest ? entry.serverTime : latest), null)
    rows.push({
      workOrder: { id: workOrder.id, number: workOrder.number, batchNumber: workOrder.batchNumber, status: workOrder.status, companyId: workOrder.companyId, siteId: workOrder.siteId, dueDate: day(workOrder.dueDate), priority: workOrder.priority, holdReason: workOrder.status === 'ON_HOLD' ? workOrder.holdReason : null },
      style: styles.get(workOrder.styleId) ?? { id: workOrder.styleId, code: '', name: '' },
      kind: 'LEATHER' as const,
      state: row.state,
      materials: [...materials.values()],
      lots: unique(row.live.map((entry) => entry.lotId)).map((lotId) => ({ id: lotId, code: lots.get(lotId)?.code ?? '', dyeBatch: lots.get(lotId)?.dyeBatch ?? null })),
      garments: { planned: garmentsPlanned, cut: garmentsCut, toCut: Math.max(0, garmentsPlanned - garmentsCut) },
      pieces: { planned: piecesPlanned, cut: row.pieces.reduce((sum, piece) => sum + piece.pieces, 0) },
      hides: { count: unique(row.live.map((entry) => entry.hideId)).length, used: [...used.entries()].map(([uom, area]) => ({ uom, area: text(area) })) },
      allocated: allocatedOf.get(workOrder.id) ?? 0,
      yield: { yieldPct: figures.overall.yieldPct, plannedPct: figures.overall.plannedPct, variancePct: figures.overall.variancePct, plannedSource: figures.plannedSource },
      stations: unique(row.live.map((entry) => entry.stationId)).map((stationId) => ({ id: stationId, code: stations.get(stationId)?.code ?? '' })),
      lastCutAt: last ? toUtcIso(last) : null,
      recutsOpen: recutsOf.get(workOrder.id) ?? 0,
    })
  }
  return rows
}

/** Today's live entries of the scope (Europe/Rome day): pieces, hides, and the area in square metres. */
async function today(db: Reader, scope: Prisma.WorkOrderWhereInput, site: Prisma.WorkOrderWhereInput, now: Date) {
  const day = businessDayRange(businessDate(now))
  const entries = await db.cutLog.findMany({
    where: { AND: [{ workOrder: { is: { AND: [scope, site] } } }, { serverTime: { gte: day.start, lt: day.end }, reversalOfId: null }] },
    select: { id: true, hideId: true, baseAreaUsed: true },
  })
  const reversed = new Set((await db.cutLog.findMany({ where: { reversalOfId: { in: entries.map((entry) => entry.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId!))
  const live = entries.filter((entry) => !reversed.has(entry.id))
  const pieces = live.length === 0 ? null : await db.cutLogPiece.aggregate({ where: { cutLogId: { in: live.map((entry) => entry.id) } }, _sum: { pieces: true } })
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(live.map((entry) => entry.hideId)) } }, select: { id: true, itemId: true } })).map((row) => [row.id, row.itemId]))
  const units = new Map((await db.item.findMany({ where: { id: { in: unique(hides.values()) } }, select: { id: true, baseUom: true } })).map((row) => [row.id, row.baseUom as Uom]))
  let area = ZERO
  for (const entry of live) {
    const ratio = fixedRatio(units.get(hides.get(entry.hideId) ?? '') ?? 'FT2', 'M2')
    if (ratio) area = area.plus(new Dec(entry.baseAreaUsed.toString()).times(ratio.toString()))
  }
  return { piecesToday: pieces?._sum.pieces ?? 0, hidesToday: hides.size, areaTodayM2: text(area.toDecimalPlaces(4, Dec.ROUND_HALF_UP)) }
}
