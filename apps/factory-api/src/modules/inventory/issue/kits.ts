import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { INVENTORY_RESERVE } from '@nexus/factory-domain/inventory/reservations/permissions'
import type { WorkOrderReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { SITE_COLUMNS, type SiteRow } from '../../planning/store'
import { livePlanOf, readinessFor, type LivePlan } from '../../planning/readiness/service'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { reserve, type ReserveLineInput } from '../reservations/reserve'
import { demandOpen, orderLinesOf, readDemands, RESERVATION_COLUMNS } from '../reservations/store'
import { byCutDate, inView, kitOf, MAX_PICK_LISTS, MAX_SHEETS, proposePicks, type KitStatus, type OpenReservation, type PickView, type ProposedPick } from './kit-rules'
import { pickListView } from './picking'
import { readPickHeader, type PickHeader, type Reader } from './store'

/**
 * Picking & kits (B-W2a-58; design warehouse.picking, SCR-237; PLN-086; SCOPE W2a rule 1 "many work orders at once need
 * one pick list"): the office's view over the pick lists of many work orders — one row per work order the floor picks for
 * (RELEASED, IN_PROGRESS, and ON_HOLD with its reason), with its cut date, the plan's readiness word (planning's
 * `readinessFor`, one live plan per site), the lines picked ("6 of 9"), the kit's state, which teams picked it and when
 * picking started and finished — the pick list sheets of several work orders at once (the modal, the PDF sorted by bin
 * path), and "Create pick lists": the reservations of what each work order still needs (./kit-rules.ts proposePicks), one
 * reservations command per work order (modules/inventory/reservations reserve: its checks, audit and event). Office only;
 * quantities only (no money); no person: a pick is said by its team (the floor device's work centre) or "the office".
 *
 *   GET  /inventory/picking/pick-lists           inventory.stock.view   rows + tiles (?siteId &view &q &limit &cursor)
 *   GET  /inventory/picking/pick-lists/sheet     inventory.stock.view   the sheets of ?workOrderIds= (1–20)
 *   POST /inventory/picking/pick-lists           inventory.reserve      reserve for each of workOrderIds (1–50)
 *
 * Not built (no schema in W2a): a kit's staging place, a kit marked complete by hand (a kit is COMPLETE when every line
 * is issued in full), substitutes (W2b).
 */

const LISTED = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const PICKABLE = ['RELEASED', 'IN_PROGRESS'] as const
const PICK_LIST_NOTE = 'Pick list (Warehouse › Picking & kits)'

const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
const keyOf = (workOrderId: string, itemId: string, itemColourId: string | null) => `${workOrderId}|${itemId}|${itemColourId ?? '-'}`

const WORK_ORDER_COLUMNS = {
  id: true,
  number: true,
  status: true,
  kind: true,
  companyId: true,
  siteId: true,
  dueDate: true,
  priority: true,
  holdReason: true,
  heldFromStatus: true,
  style: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.WorkOrderSelect
type WorkOrderRow = Prisma.WorkOrderGetPayload<{ select: typeof WORK_ORDER_COLUMNS }>

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

/** One live plan per site, read once for a request (planning's readiness: the same netting as a run). */
async function readinessBySite(db: Reader, sites: readonly SiteRow[], workOrders: readonly WorkOrderRow[]): Promise<{ readiness: Map<string, WorkOrderReadiness>; plans: Map<string, LivePlan> }> {
  const readiness = new Map<string, WorkOrderReadiness>()
  const plans = new Map<string, LivePlan>()
  for (const site of sites) {
    const ids = workOrders.filter((row) => row.siteId === site.id).map((row) => row.id)
    if (ids.length === 0) continue
    const live = await livePlanOf(db, site)
    plans.set(site.id, live)
    for (const answer of await readinessFor(db, site, ids, live)) readiness.set(answer.workOrderId, answer)
  }
  return { readiness, plans }
}

/** The purchase order lines a readiness material counts on, with their order (the popover's "Open PO"). */
function purchaseOrdersOf(live: LivePlan | undefined, lineIds: readonly string[]) {
  if (!live) return []
  const lines = live.inputs.purchases.filter((line) => lineIds.includes(line.purchaseOrderLineId))
  const seen = new Map<string, { id: string; number: string; status: string; dueDate: string }>()
  for (const line of lines) if (!seen.has(line.purchaseOrderId)) seen.set(line.purchaseOrderId, { id: line.purchaseOrderId, number: line.purchaseOrderNumber, status: line.purchaseOrderStatus, dueDate: line.dueDate })
  return [...seen.values()].sort((a, b) => (a.number < b.number ? -1 : 1))
}

function readinessView(answer: WorkOrderReadiness | undefined, live: LivePlan | undefined) {
  if (!answer) return { word: 'NOT_PLANNED' as const, label: 'Not planned', date: null, reason: 'The plan has no material need for this work order.', materials: [] }
  return {
    word: answer.word,
    label: answer.label,
    date: answer.date,
    reason: answer.reason,
    materials: answer.materials.map((material) => ({
      itemId: material.itemId,
      itemColourId: material.itemColourId,
      label: material.label,
      uom: material.uom,
      word: material.word,
      date: material.date,
      needed: material.needed,
      issued: material.issued,
      reserved: material.reserved,
      inStock: material.inStock,
      onOrder: material.onOrder,
      short: material.short,
      reason: material.reason,
      purchaseOrders: purchaseOrdersOf(live, material.purchaseOrderLineIds),
    })),
  }
}

/** The facts of many work orders in a few grouped reads: lines, issues, teams, reservations, cut dates, pieces. */
async function factsOf(db: Reader, workOrders: readonly WorkOrderRow[], sites: ReadonlyMap<string, SiteRow>) {
  const ids = workOrders.map((row) => row.id)
  const planned = await db.workOrderMaterial.groupBy({ by: ['workOrderId', 'itemId', 'itemColourId'], where: { workOrderId: { in: ids } }, _sum: { baseQuantity: true } })
  const by = ['workOrderId', 'itemId', 'itemColourId'] as const
  const out = await db.stockMove.groupBy({ by: [...by], where: { workOrderId: { in: ids }, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: [...by], where: { workOrderId: { in: ids }, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const issued = new Map<string, Decimal>()
  for (const row of out) if (row.workOrderId) issued.set(keyOf(row.workOrderId, row.itemId, row.itemColourId), (issued.get(keyOf(row.workOrderId, row.itemId, row.itemColourId)) ?? ZERO).plus(dec(row._sum.baseQuantity)))
  for (const row of back) if (row.workOrderId) issued.set(keyOf(row.workOrderId, row.itemId, row.itemColourId), (issued.get(keyOf(row.workOrderId, row.itemId, row.itemColourId)) ?? ZERO).minus(dec(row._sum.baseQuantity)))
  const issues = await db.stockMove.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids }, reason: 'ISSUE', reversalOfId: null }, _min: { occurredAt: true }, _max: { occurredAt: true } })
  const posters = await db.stockMove.groupBy({ by: ['workOrderId', 'deviceId'], where: { workOrderId: { in: ids }, reason: 'ISSUE', reversalOfId: null }, _count: { _all: true } })
  const deviceIds = [...new Set(posters.flatMap((row) => (row.deviceId ? [row.deviceId] : [])))]
  const devices = deviceIds.length === 0 ? [] : await db.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true, stationId: true } })
  const stationIds = [...new Set(devices.flatMap((device) => (device.stationId ? [device.stationId] : [])))]
  const stations = stationIds.length === 0 ? [] : await db.station.findMany({ where: { id: { in: stationIds } }, select: { id: true, workCentreId: true } })
  const centres = stations.length === 0 ? [] : await db.workCentre.findMany({ where: { id: { in: [...new Set(stations.map((station) => station.workCentreId))] } }, select: { id: true, code: true, name: true } })
  const teamOf = (deviceId: string | null): { kind: 'OFFICE' | 'TEAM'; name: string | null } => {
    if (!deviceId) return { kind: 'OFFICE', name: null }
    const device = devices.find((row) => row.id === deviceId)
    const station = device?.stationId ? stations.find((row) => row.id === device.stationId) : undefined
    const centre = station ? centres.find((row) => row.id === station.workCentreId) : undefined
    return { kind: 'TEAM', name: centre?.name ?? device?.name ?? null }
  }
  const reservations = await db.reservation.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids }, status: { in: ['ACTIVE', 'ISSUED'] } }, _count: { _all: true }, _min: { createdAt: true } })
  const slots = await db.scheduleSlot.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids }, planKind: 'WORKING' }, _min: { startAt: true } })
  const pieces = await db.workOrderSize.groupBy({ by: ['workOrderId'], where: { workOrderId: { in: ids } }, _sum: { quantity: true } })
  return workOrders.map((row) => {
    const lines = planned.filter((entry) => entry.workOrderId === row.id).map((entry) => ({ planned: dec(entry._sum.baseQuantity).toFixed(4), issued: (issued.get(keyOf(row.id, entry.itemId, entry.itemColourId)) ?? ZERO).toFixed(4) }))
    const kit = kitOf(lines)
    const issue = issues.find((entry) => entry.workOrderId === row.id)
    const teams = new Map<string, { kind: 'OFFICE' | 'TEAM'; name: string | null }>()
    for (const poster of posters.filter((entry) => entry.workOrderId === row.id)) {
      const team = teamOf(poster.deviceId)
      teams.set(`${team.kind}|${team.name ?? ''}`, team)
    }
    const reserved = reservations.find((entry) => entry.workOrderId === row.id)
    const slot = slots.find((entry) => entry.workOrderId === row.id)
    const site = sites.get(row.siteId)
    return {
      kit,
      startedAt: issue?._min.occurredAt ? toUtcIso(issue._min.occurredAt) : null,
      finishedAt: kit.status === 'COMPLETE' && issue?._max.occurredAt ? toUtcIso(issue._max.occurredAt) : null,
      pickedBy: [...teams.values()].sort((a, b) => (a.kind !== b.kind ? (a.kind === 'TEAM' ? -1 : 1) : (a.name ?? '') < (b.name ?? '') ? -1 : 1)),
      pickList: { created: (reserved?._count._all ?? 0) > 0, reservations: reserved?._count._all ?? 0, createdAt: reserved?._min.createdAt ? toUtcIso(reserved._min.createdAt) : null },
      cutDate: slot?._min.startAt ? businessDate(slot._min.startAt, site?.timezone) : null,
      pieces: pieces.find((entry) => entry.workOrderId === row.id)?._sum.quantity ?? 0,
    }
  })
}

const workOrderView = (row: WorkOrderRow, pieces: number) => ({
  id: row.id,
  number: row.number,
  status: row.status,
  kind: row.kind,
  companyId: row.companyId,
  siteId: row.siteId,
  dueDate: day(row.dueDate),
  priority: row.priority,
  pieces,
  style: row.style,
  onHold: row.status === 'ON_HOLD' ? { reason: row.holdReason, from: row.heldFromStatus } : null,
})

/** The sites the caller sees stock of (planning's columns: the time zone of each site's day). */
async function sitesOf(db: Reader, context: StockContext, siteIds?: readonly string[]): Promise<SiteRow[]> {
  return db.site.findMany({
    where: { AND: [scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, siteIds ? { id: { in: [...siteIds] } } : {}] },
    select: SITE_COLUMNS,
    orderBy: { code: 'asc' },
  })
}

export interface PickListsQuery {
  readonly siteId?: string | undefined
  readonly view: PickView
  readonly q?: string | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

/** GET /inventory/picking/pick-lists: one row per work order the floor picks for, the tiles, paged by an offset cursor. */
export async function listPickLists(caller: CommandCaller, query: PickListsQuery) {
  const context = stockContextOf(caller)
  if (query.siteId && !isUuid(query.siteId)) throw new NotFoundError('Site not found.')
  return caller.withClient(async (db) => {
    const sites = await sitesOf(db, context, query.siteId ? [query.siteId] : undefined)
    if (query.siteId && sites.length === 0) throw new NotFoundError('Site not found.')
    const workOrders = await db.workOrder.findMany({
      where: {
        AND: [
          scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
          { status: { in: [...LISTED] }, siteId: { in: sites.map((site) => site.id) } },
        ],
      },
      select: WORK_ORDER_COLUMNS,
      orderBy: { number: 'asc' },
      take: 500,
    })
    const siteMap = new Map(sites.map((site) => [site.id, site]))
    const { readiness, plans } = await readinessBySite(db, sites, workOrders)
    const facts = workOrders.length === 0 ? [] : await factsOf(db, workOrders, siteMap)
    const now = serverClock.now()
    const rows = workOrders
      .map((row, index) => {
        const fact = facts[index]!
        return {
          workOrder: workOrderView(row, fact.pieces),
          cutDate: fact.cutDate,
          readiness: readinessView(readiness.get(row.id), plans.get(row.siteId)),
          lines: { all: fact.kit.all, picked: fact.kit.picked, short: fact.kit.short },
          kit: { status: fact.kit.status as KitStatus, location: null },
          pickList: fact.pickList,
          pickedBy: fact.pickedBy,
          startedAt: fact.startedAt,
          finishedAt: fact.finishedAt,
          today: businessDate(now, siteMap.get(row.siteId)?.timezone),
        }
      })
      .sort(byCutDate)
    const facts4 = (row: (typeof rows)[number]) => ({ kit: row.kit.status, word: row.readiness.word, cutDate: row.cutDate, created: row.pickList.created, status: row.workOrder.status })
    const q = query.q?.trim().toLowerCase() ?? ''
    const searched = q === '' ? rows : rows.filter((row) => [row.workOrder.number, row.workOrder.style.code, row.workOrder.style.name].some((text) => text.toLowerCase().includes(q)))
    const tiles = {
      today: searched.filter((row) => inView('today', facts4(row), row.today)).length,
      waiting: searched.filter((row) => inView('waiting', facts4(row), row.today)).length,
      complete: searched.filter((row) => inView('complete', facts4(row), row.today)).length,
      toCreate: searched.filter((row) => inView('toCreate', facts4(row), row.today)).length,
      all: searched.length,
    }
    const viewed = searched.filter((row) => inView(query.view, facts4(row), row.today))
    const offset = query.cursor && /^\d+$/.test(query.cursor) ? Number.parseInt(query.cursor, 10) : 0
    const page = viewed.slice(offset, offset + query.limit).map(({ today: _today, ...row }) => row)
    return {
      asOf: toUtcIso(now),
      sites: sites.map((site) => ({ id: site.id, code: site.code, name: site.name })),
      tiles,
      rows: page,
      total: viewed.length,
      nextCursor: offset + query.limit < viewed.length ? String(offset + query.limit) : null,
    }
  })
}

// ---- the pick list of one work order with what it proposes ----------------------------------------------------------------

/** A work order's pick list (picking.ts pickListView, quality holds included), with its reservations and what a pick list proposes. */
async function sheetOf(db: Reader, context: StockContext, header: PickHeader) {
  const view = await pickListView(db, context, header)
  const items = [...new Set(view.lines.map((line) => line.itemId))]
  const rows = items.length === 0 ? [] : await db.reservation.findMany({ where: { siteId: header.siteId, itemId: { in: items }, status: 'ACTIVE' }, select: RESERVATION_COLUMNS, orderBy: { id: 'asc' } })
  const demands = await readDemands(db, rows, { withOrders: false })
  const ownLines = await orderLinesOf(db, header.id)
  const mineOf = (row: (typeof rows)[number]) => row.workOrderId === header.id || (row.salesOrderLineId !== null && ownLines.has(row.salesOrderLineId))
  const issuedRows = await db.reservation.findMany({ where: { workOrderId: header.id, status: { in: ['ACTIVE', 'ISSUED'] } }, select: { id: true, itemId: true, itemColourId: true, lotId: true, hideId: true, quantity: true, issuedQuantity: true, status: true } })
  const lotIds = [...new Set(issuedRows.flatMap((row) => (row.lotId ? [row.lotId] : [])))]
  const hideIds = [...new Set(issuedRows.flatMap((row) => (row.hideId ? [row.hideId] : [])))]
  const lotCodes = new Map((lotIds.length === 0 ? [] : await db.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const hideCodes = new Map((hideIds.length === 0 ? [] : await db.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const open = (row: { quantity: { toString(): string }; issuedQuantity: { toString(): string } }) => Dec.max(ZERO, dec(row.quantity).minus(dec(row.issuedQuantity))).toFixed(4)
  const lines = view.lines.map((line) => {
    const same = rows.filter((row) => row.itemId === line.itemId && row.itemColourId === line.itemColourId && demandOpen(row, demands))
    const toOpen = (row: (typeof rows)[number]): OpenReservation => ({ id: row.id, lotId: row.lotId, hideId: row.hideId, open: open(row) })
    const proposal = proposePicks({
      tracking: line.tracking,
      toIssue: line.toIssue,
      sources: line.usable.candidates,
      mine: same.filter(mineOf).map(toOpen),
      others: same.filter((row) => !mineOf(row)).map(toOpen),
    })
    const reservations = issuedRows
      .filter((row) => row.itemId === line.itemId && row.itemColourId === line.itemColourId)
      .map((row) => ({
        id: row.id,
        status: row.status,
        lotId: row.lotId,
        lotCode: row.lotId ? (lotCodes.get(row.lotId) ?? null) : null,
        hideId: row.hideId,
        hideCode: row.hideId ? (hideCodes.get(row.hideId) ?? null) : null,
        quantity: dec(row.quantity).toFixed(4),
        issued: dec(row.issuedQuantity).toFixed(4),
        // Where it lies now: the usable candidates of its hide or lot (an any-lot one: none named).
        locations: line.usable.candidates
          .filter((candidate) => (row.hideId ? candidate.hideId === row.hideId : row.lotId ? candidate.lotId === row.lotId : false))
          .map((candidate) => ({ locationId: candidate.locationId, locationCode: candidate.locationCode, onHand: candidate.onHand })),
      }))
    return { ...line, pick: { reserved: proposal.reserved, short: proposal.short, proposed: proposal.picks, reservations } }
  })
  return { ...view, lines }
}

/** GET /inventory/picking/pick-lists/sheet?workOrderIds=: the pick lists of up to 20 work orders (the modal, the PDF). */
export async function pickListSheets(caller: CommandCaller, query: { readonly workOrderIds: string }) {
  const context = stockContextOf(caller)
  const ids = [...new Set(query.workOrderIds.split(',').map((value) => value.trim()).filter((value) => value !== ''))]
  if (ids.length === 0 || ids.length > MAX_SHEETS || ids.some((value) => !isUuid(value))) {
    throw new ValidationError(`Name 1 to ${MAX_SHEETS} work orders by their ids.`, [{ path: 'querystring/workOrderIds', message: `Comma-separated work order ids, 1 to ${MAX_SHEETS}.` }])
  }
  return caller.withClient(async (db) => {
    const headers: PickHeader[] = []
    for (const id of ids) {
      const header = await readPickHeader(db, id)
      if (!header || !mayAt(context, INVENTORY_STOCK_VIEW, header)) throw new NotFoundError('Work order not found.')
      headers.push(header)
    }
    const sites = await sitesOf(db, context, [...new Set(headers.map((header) => header.siteId))])
    const siteMap = new Map(sites.map((site) => [site.id, site]))
    const workOrders = await db.workOrder.findMany({ where: { id: { in: ids } }, select: WORK_ORDER_COLUMNS })
    const ordered = ids.map((id) => workOrders.find((row) => row.id === id)!)
    const { readiness, plans } = await readinessBySite(db, sites, ordered)
    const facts = await factsOf(db, ordered, siteMap)
    const sheets = []
    for (const [index, header] of headers.entries()) {
      const sheet = await sheetOf(db, context, header)
      const fact = facts[index]!
      const row = ordered[index]!
      sheets.push({
        workOrder: { ...workOrderView(row, fact.pieces), batchNumber: header.batchNumber, version: header.version, issuable: sheet.workOrder.issuable },
        cutDate: fact.cutDate,
        readiness: readinessView(readiness.get(row.id), plans.get(row.siteId)),
        kit: { status: fact.kit.status as KitStatus, location: null, all: fact.kit.all, picked: fact.kit.picked, short: fact.kit.short },
        pickList: fact.pickList,
        pickedBy: fact.pickedBy,
        startedAt: fact.startedAt,
        finishedAt: fact.finishedAt,
        lines: sheet.lines,
      })
    }
    return { asOf: toUtcIso(serverClock.now()), sheets }
  })
}

// ---- Create pick lists -----------------------------------------------------------------------------------------------------

export interface CreatePickListsInput {
  readonly siteId: string
  readonly workOrderIds: readonly string[]
}

type CreateResult = {
  readonly workOrderId: string
  readonly number: string | null
  readonly outcome: 'CREATED' | 'NOTHING_TO_RESERVE' | 'REFUSED'
  readonly reserved: { readonly itemCode: string; readonly colourCode: string | null; readonly kind: ProposedPick['kind']; readonly lotCode: string | null; readonly hideCode: string | null; readonly quantity: string; readonly baseUom: string }[]
  readonly short: { readonly itemCode: string; readonly colourCode: string | null; readonly quantity: string; readonly baseUom: string }[]
  readonly refusal: { readonly code: string; readonly message: string } | null
}

const refusalOf = (error: unknown): { code: string; message: string } | null => {
  if (!(error instanceof ConflictError) && !(error instanceof ValidationError) && !(error instanceof NotFoundError)) return null
  const issues = (error as { issues?: readonly Issue[] }).issues ?? []
  const coded = issues.map((issue) => /refusal\/([A-Z_]+)$/.exec(issue.path)?.[1]).find((code): code is string => Boolean(code))
  return { code: coded ?? (error instanceof NotFoundError ? 'NOT_FOUND' : error instanceof ValidationError ? 'INVALID' : 'CONFLICT'), message: error.message }
}

/**
 * POST /inventory/picking/pick-lists: for each work order (in the order given: the dialog's cut-date order, so the work
 * order cut first is served first when material is short), what it still needs is reserved from the usable stock — ONE
 * reservations command per work order (a refusal of one is said beside it; the others go on). A work order already
 * fully reserved or issued gets nothing new ("nothing to reserve"); what the stock cannot cover stays short (readiness says
 * Not enough or what is expected). Answers each work order's outcome.
 */
export async function createPickLists(caller: CommandCaller, body: CreatePickListsInput, idempotencyKey?: string): Promise<{ results: CreateResult[]; created: number }> {
  const context = stockContextOf(caller)
  const ids = [...new Set(body.workOrderIds)]
  if (ids.length === 0 || ids.length > MAX_PICK_LISTS) throw new ValidationError(`Create 1 to ${MAX_PICK_LISTS} pick lists at once.`, [{ path: 'body/workOrderIds', message: `1 to ${MAX_PICK_LISTS} work orders.` }])
  const site = await caller.withClient((db) => db.site.findUnique({ where: { id: body.siteId }, select: SITE_COLUMNS }))
  if (!site || !mayAt(context, INVENTORY_RESERVE, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  const results: CreateResult[] = []
  for (const [index, workOrderId] of ids.entries()) {
    const header = await caller.withClient((db) => readPickHeader(db, workOrderId))
    if (!header || header.siteId !== site.id || !mayAt(context, INVENTORY_RESERVE, header)) {
      results.push({ workOrderId, number: null, outcome: 'REFUSED', reserved: [], short: [], refusal: { code: 'NOT_FOUND', message: 'Not a work order of this site.' } })
      continue
    }
    if (!(PICKABLE as readonly string[]).includes(header.status)) {
      const words = header.status === 'ON_HOLD' ? `Work order ${header.number} is on hold: its pick list waits until the hold is lifted.` : `Work order ${header.number} is ${header.status.toLowerCase().replace('_', ' ')}: a pick list is made for a released work order.`
      results.push({ workOrderId, number: header.number, outcome: 'REFUSED', reserved: [], short: [], refusal: { code: header.status === 'ON_HOLD' ? 'ON_HOLD' : 'NOT_RELEASED', message: words } })
      continue
    }
    const sheet = await caller.withClient((db) => sheetOf(db, context, header))
    const lines: ReserveLineInput[] = []
    const reserved: CreateResult['reserved'][number][] = []
    const short: CreateResult['short'][number][] = []
    for (const line of sheet.lines) {
      for (const pick of line.pick.proposed) {
        lines.push(pick.kind === 'HIDE' ? { hideId: pick.hideId! } : pick.kind === 'LOT' ? { lotId: pick.lotId!, quantity: pick.quantity } : { itemId: line.itemId, itemColourId: line.itemColourId, quantity: pick.quantity })
        reserved.push({ itemCode: line.itemCode, colourCode: line.colourCode, kind: pick.kind, lotCode: pick.lotCode, hideCode: pick.hideCode, quantity: pick.quantity, baseUom: line.baseUom })
      }
      if (dec(line.pick.short).gt(0)) short.push({ itemCode: line.itemCode, colourCode: line.colourCode, quantity: line.pick.short, baseUom: line.baseUom })
    }
    if (lines.length === 0) {
      results.push({ workOrderId, number: header.number, outcome: 'NOTHING_TO_RESERVE', reserved: [], short, refusal: null })
      continue
    }
    try {
      await reserve(caller, { siteId: site.id, workOrderId, note: PICK_LIST_NOTE, lines }, idempotencyKey ? `${idempotencyKey}:${index}` : undefined)
      results.push({ workOrderId, number: header.number, outcome: 'CREATED', reserved, short, refusal: null })
    } catch (error) {
      const refusal = refusalOf(error)
      if (!refusal) throw error
      results.push({ workOrderId, number: header.number, outcome: 'REFUSED', reserved: [], short, refusal })
    }
  }
  return { results, created: results.filter((result) => result.outcome === 'CREATED').length }
}
