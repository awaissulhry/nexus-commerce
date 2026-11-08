import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { Language } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUT, PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { CUT_TICKET_LABEL_KIND } from '@nexus/factory-domain/production/cutorders/tickets'
import type { CutTicketKind, CutTicketStatus } from '@nexus/factory-domain/production/cutorders/rules'
import { PRODUCTION_RECUTS } from '@nexus/factory-domain/production/cutissue/permissions'
import {
  compareRecutRows,
  nextRecutScan,
  RECUT_LIMITS,
  RECUT_NEXT_WORDS,
  recutFinishRefusal,
  recutLines,
  recutMakeRefusal,
  recutStartRefusal,
  recutWarnings,
  recutZpl,
  sourceWords,
  type RecutLabel,
  type RecutLot,
} from '@nexus/factory-domain/production/rework/recut'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { activeHoldsOf } from '../../quality/holds/checks'
import { assertFloorReady } from '../bundles/bundles'
import { asTenantSystem } from '../bundles/codes'
import type { BundleRow } from '../bundles/store'
import { floorOf, may, officeOf, refuse, seen, workerOf } from '../cutissue/access'
import { emitRecut } from '../cutissue/emit'
import { cellCutFacts, cellText, findBundle, liveOf, readBundles, readCells, readLot, readLots, readOrder, readOrders, readStyles, shadeLotsOf, type OrderRow, type Reader } from '../cutissue/store'
import { jobKey, labelTarget, queueLabel } from '../cutorders/printing'
import { lockReplacement, readReplacement } from '../scrap/store'

/**
 * Recut tickets (B-W2b-117; MES-044; design floor.fabriccut "Recut tickets", the scrap page's "Ask for recut"): replacement panels
 * of one cell that join the original bundle, cut from the same shade lot or from end bits (rules: factory-domain
 * production/rework/recut). A recut ticket is a CutTicket of kind RECUT, numbered from the company's CUT_TICKET series by an
 * office command, or — asked at a tablet of sewing or quality — by the tenant's system caller after the tablet's checks (a ticket
 * number is never taken by the tablet).
 *
 *   GET  /production/recut-tickets                   office (production.cutting.view): every recut ticket, newest first; tiles
 *   GET  /production/recut-tickets/waiting           office + floor (production.cut): the site's recuts to cut (OPEN, STARTED)
 *   GET  /production/recut-tickets/scan?code=        office + floor (production.cut): the ticket's card and what the scan does
 *   GET  /production/recut-tickets/options?code=     office + floor (production.recuts): what a recut of this bundle can be
 *   POST /production/recut-tickets                   office + floor (production.recuts): make one (office: also from an OPEN
 *                                                    RECUT replacement request, which then names it)
 *   POST /production/recut-tickets/:id/print         office + floor (production.cut): the label (ZPL, label kind CUT_TICKET)
 *   POST /production/recut-tickets/start | finish    floor (production.cut): the cutter's scans at the start and the end
 *   POST /production/recut-tickets/:id/void          office (production.recuts): a lost or wrong one, with the reason
 *
 * Each write is ONE command (a tablet's with its Idempotency-Key), audited (the ticket, its work order, and at the end its
 * bundle: the recut joins its genealogy), with recut_ticket.changed. No worker is named; no money.
 */

const at = (value: Date | null) => (value ? toUtcIso(value) : null)
const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)

const RECUT_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  scanCode: true,
  kind: true,
  status: true,
  workOrderId: true,
  workOrderSizeId: true,
  bundleId: true,
  part: true,
  quantity: true,
  lotId: true,
  endBits: true,
  printedAt: true,
  startedAt: true,
  doneAt: true,
  voidedAt: true,
  voidReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.CutTicketSelect
type RecutRow = Prisma.CutTicketGetPayload<{ select: typeof RECUT_COLUMNS }>

/** Builds the views of recut tickets (the replacement each answers, for the office only: the floor reads no replacement). */
async function recutViews(db: Reader, rows: readonly RecutRow[], office: boolean) {
  const [orders, cells, bundles, lots, replacements] = await Promise.all([
    readOrders(db, rows.map((row) => row.workOrderId!)),
    readCells(db, rows.map((row) => row.workOrderSizeId!)),
    readBundles(db, rows.flatMap((row) => (row.bundleId ? [row.bundleId] : []))),
    readLots(db, rows.flatMap((row) => (row.lotId ? [row.lotId] : []))),
    office && rows.length > 0 ? db.replacementRequest.findMany({ where: { recutTicketId: { in: rows.map((row) => row.id) } }, select: { id: true, recutTicketId: true, status: true, quantity: true, reason: true } }) : Promise.resolve([]),
  ])
  const styles = await readStyles(db, [...orders.values()].map((order) => order.styleId))
  return rows.map((row) => {
    const order = orders.get(row.workOrderId!)
    const cell = cells.get(row.workOrderSizeId!)
    const bundle = row.bundleId ? bundles.get(row.bundleId) : undefined
    const lot = row.lotId ? lots.get(row.lotId) : undefined
    const replacement = replacements.find((request) => request.recutTicketId === row.id)
    const style = order ? styles.get(order.styleId) : undefined
    return {
      id: row.id,
      number: row.number,
      code: row.scanCode,
      status: row.status as CutTicketStatus,
      workOrder: { id: row.workOrderId!, number: order?.number ?? '', status: order?.status ?? 'RELEASED', dueDate: day(order?.dueDate ?? null), rush: order?.rush ?? false, style: { code: style?.code ?? '', name: style?.name ?? '' } },
      cell: { id: row.workOrderSizeId!, colourwayCode: cell?.colourwayCode ?? '', size: cell?.size ?? '' },
      bundle: bundle ? { id: bundle.id, code: bundle.code, part: bundle.part, status: bundle.status as 'ACTIVE' | 'VOID' } : null,
      part: row.part,
      quantity: row.quantity!,
      lot: lot ? { id: lot.id, code: lot.code, dyeBatch: lot.dyeBatch, shade: lot.shade } : null,
      endBits: row.endBits,
      from: { it: sourceWords({ lotCode: lot?.code ?? null, endBits: row.endBits }, 'it'), en: sourceWords({ lotCode: lot?.code ?? null, endBits: row.endBits }, 'en') },
      replacement: replacement ? { id: replacement.id, status: replacement.status, quantity: replacement.quantity, reason: replacement.reason } : null,
      printedAt: at(row.printedAt),
      startedAt: at(row.startedAt),
      doneAt: at(row.doneAt),
      voidedAt: at(row.voidedAt),
      voidReason: row.voidReason,
      createdAt: toUtcIso(row.createdAt),
      version: row.version,
    }
  })
}
type RecutView = Awaited<ReturnType<typeof recutViews>>[number]

const viewOf = async (db: Reader, row: RecutRow, office: boolean): Promise<RecutView> => (await recutViews(db, [row], office))[0]!

async function readRecut(db: Reader, ticketId: string): Promise<RecutRow | null> {
  if (!isUuid(ticketId)) return null
  return db.cutTicket.findUnique({ where: { id: ticketId }, select: RECUT_COLUMNS })
}

// ---- lists --------------------------------------------------------------------------------------------------------------------

export const RECUT_VIEWS = ['open', 'started', 'done', 'void', 'all'] as const
export type RecutListView = (typeof RECUT_VIEWS)[number]
const VIEW_STATUSES: Record<RecutListView, readonly CutTicketStatus[] | null> = { open: ['OPEN', 'STARTED'], started: ['STARTED'], done: ['DONE'], void: ['VOID'], all: null }

export interface RecutListQuery {
  readonly view?: RecutListView | undefined
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly bundleId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** GET /production/recut-tickets: the office's list, newest first, with a tile per status. */
export async function listRecuts(caller: CommandCaller, query: RecutListQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.CutTicketWhereInput
  const limit = Math.min(query.limit ?? 50, RECUT_LIMITS.rows)
  const q = query.q?.trim()
  const base: Prisma.CutTicketWhereInput[] = [
    scope,
    { kind: 'RECUT' },
    query.siteId ? { siteId: query.siteId } : {},
    query.workOrderId ? { workOrderId: query.workOrderId } : {},
    query.bundleId ? { bundleId: query.bundleId } : {},
    q ? { OR: [{ number: { contains: q, mode: 'insensitive' } }, { part: { contains: q, mode: 'insensitive' } }, { bundle: { is: { code: { contains: q.toUpperCase() } } } }, { workOrderSize: { is: { workOrder: { number: { contains: q, mode: 'insensitive' } } } } }] } : {},
  ]
  const statuses = VIEW_STATUSES[query.view ?? 'open']
  return caller.withClient(async (db) => {
    const rows = await db.cutTicket.findMany({
      where: { AND: [...base, statuses ? { status: { in: [...statuses] } } : {}, query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}] },
      select: RECUT_COLUMNS,
      orderBy: { id: 'desc' },
      take: limit + 1,
    })
    const page = rows.slice(0, limit)
    const counts = await db.cutTicket.groupBy({ by: ['status'], where: { AND: base }, _count: { _all: true } })
    const count = (status: CutTicketStatus) => counts.find((row) => row.status === status)?._count._all ?? 0
    return {
      rows: await recutViews(db, page, true),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      tiles: { open: count('OPEN'), started: count('STARTED'), done: count('DONE'), void: count('VOID') },
    }
  })
}

/** GET /production/recut-tickets/waiting: the site's recuts to cut (floor: its own site), started first, then due, then oldest. */
export async function waitingRecuts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = workerOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUT, { company: 'companyId', site: 'siteId' }) as Prisma.CutTicketWhereInput
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  return caller.withClient(async (db) => {
    const rows = await db.cutTicket.findMany({ where: { AND: [scope, siteId ? { siteId } : {}, { kind: 'RECUT', status: { in: ['OPEN', 'STARTED'] } }] }, select: RECUT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: RECUT_LIMITS.rows })
    const views = (await recutViews(db, rows, context.audience === 'office')).sort((a, b) => compareRecutRows({ status: a.status, dueDate: a.workOrder.dueDate, createdAt: a.createdAt, number: a.number }, { status: b.status, dueDate: b.workOrder.dueDate, createdAt: b.createdAt, number: b.number }))
    return { rows: views, counts: { open: views.filter((row) => row.status === 'OPEN').length, started: views.filter((row) => row.status === 'STARTED').length } }
  })
}

// ---- a scanned ticket -----------------------------------------------------------------------------------------------------------

/** The recut ticket the caller may cut by its code (a floor device: its own site); 404 otherwise. A CUT ticket is refused in words. */
async function recutByCode(db: Reader, context: OfficeContext | FloorContext, code: string): Promise<RecutRow> {
  const scan = code.trim().toUpperCase()
  const ticket = scan === '' ? null : await db.cutTicket.findFirst({ where: { scanCode: scan }, select: RECUT_COLUMNS })
  if (!ticket || !may(context, PRODUCTION_CUT, ticket)) throw new NotFoundError(`No cut ticket ${scan} at this site.`)
  if (ticket.kind !== 'RECUT') refuse({ code: 'TICKET_IS_CUT', message: `Ticket ${ticket.number} cuts a cut order: scan it on the cut ticket, not as a recut.` })
  return ticket
}

async function scanFacts(db: Reader, ticket: RecutRow) {
  const order = (await readOrder(db, ticket.workOrderId!))!
  const bundle = ticket.bundleId ? (await readBundles(db, [ticket.bundleId])).get(ticket.bundleId) ?? null : null
  return { order, bundle }
}

const facts = (ticket: RecutRow) => ({ number: ticket.number, kind: ticket.kind as CutTicketKind, status: ticket.status as CutTicketStatus, voidReason: ticket.voidReason })

/** The card: the ticket and what the next scan does (or why it would stop), in words it/en. */
async function cardOf(db: Reader, ticket: RecutRow, office: boolean) {
  const { order, bundle } = await scanFacts(db, ticket)
  const next = nextRecutScan(facts(ticket), order, bundle ? { code: bundle.code, status: bundle.status } : null)
  return { ticket: await viewOf(db, ticket, office), next: { ...next, words: { it: RECUT_NEXT_WORDS.it[next.next], en: RECUT_NEXT_WORDS.en[next.next] } } }
}

/** GET /production/recut-tickets/scan?code=. */
export async function scanRecut(caller: CommandCaller, code: string) {
  const context = workerOf(caller)
  return caller.withClient(async (db) => cardOf(db, await recutByCode(db, context, code), context.audience === 'office'))
}

// ---- what a recut of this bundle can be ------------------------------------------------------------------------------------------

async function bundleFacts(db: Reader, bundle: BundleRow) {
  const [order, cells, live, shadeLots] = await Promise.all([readOrder(db, bundle.workOrderId), readCells(db, [bundle.workOrderSizeId]), liveOf(db, [bundle]), shadeLotsOf(db, bundle)])
  const cell = cells.get(bundle.workOrderSizeId)!
  const cut = await cellCutFacts(db, cell.id, cell.size)
  return { order: order!, cell, live: live.get(bundle.id) ?? bundle.quantity, shadeLots, ...cut }
}

/** GET /production/recut-tickets/options?code=|bundleId=: the bundle, its cell, parts, shade lots and (office) the open recut requests. */
export async function recutOptions(caller: CommandCaller, query: { readonly code?: string | undefined; readonly bundleId?: string | undefined }) {
  const context = workerOf(caller)
  if (!query.code && !query.bundleId) throw new ValidationError('Scan the bundle, or name it.', [{ path: 'querystring/code', message: 'Scan the bundle’s ticket.' }])
  return caller.withClient(async (db) => {
    const bundle = await findBundle(db, query)
    const order = bundle ? await readOrder(db, bundle.workOrderId) : null
    seen(context, PRODUCTION_RECUTS, order, 'Bundle')
    const found = await bundleFacts(db, bundle!)
    const replacements =
      context.audience === 'office'
        ? await db.replacementRequest.findMany({ where: { workOrderSizeId: found.cell.id, kind: 'RECUT', status: 'OPEN', recutTicketId: null }, select: { id: true, quantity: true, part: true, reason: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 50 })
        : []
    const refusal =
      recutMakeRefusal({ workOrder: found.order, bundle: { code: bundle!.code, status: bundle!.status, workOrderSizeId: bundle!.workOrderSizeId, live: found.live }, cell: { id: found.cell.id, label: cellText(found.cell), parts: found.parts }, part: null, quantity: 1, lot: null, endBits: true, materials: found.materials, shadeLots: found.shadeLots, replacement: null }) ?? null
    return {
      bundle: { id: bundle!.id, code: bundle!.code, part: bundle!.part, status: bundle!.status as 'ACTIVE' | 'VOID', live: found.live },
      workOrder: { id: found.order.id, number: found.order.number, status: found.order.status },
      cell: { id: found.cell.id, colourwayCode: found.cell.colourwayCode, size: found.cell.size },
      parts: found.parts,
      shadeLots: found.shadeLots.map((lot) => ({ id: lot.id, code: lot.code, dyeBatch: lot.dyeBatch, shade: lot.shade })),
      replacements: replacements.map((row) => ({ id: row.id, quantity: row.quantity, part: row.part, reason: row.reason, createdAt: toUtcIso(row.createdAt) })),
      refusal,
    }
  })
}

// ---- make -----------------------------------------------------------------------------------------------------------------------

export interface MakeBody {
  readonly bundleId?: string | undefined
  readonly code?: string | undefined
  readonly replacementId?: string | undefined
  readonly part?: string | null | undefined
  readonly quantity?: number | undefined
  readonly lotId?: string | null | undefined
  readonly endBits?: boolean | undefined
  readonly reason: string
}

/**
 * Inside the command (the office's, or the tenant's system caller for a tablet's ask): the facts read again under the
 * replacement's row lock, the rules, the CUT_TICKET number, the ticket, the replacement naming it, audit and the event.
 */
async function makeInCommand(tools: CommandTools, body: MakeBody, asker: { readonly floor: FloorContext | null }) {
  const { tx, now } = tools
  const replacement = body.replacementId ? await lockReplacement(tx, body.replacementId) : null
  if (body.replacementId && !replacement) throw new NotFoundError('Replacement not found.')
  let bundle = await findBundle(tx, { bundleId: body.bundleId, code: body.code })
  if ((body.bundleId || body.code) && !bundle) throw new NotFoundError('Bundle not found.')
  if (!bundle && replacement?.sourceScanId) {
    const scan = await tx.operationScan.findUnique({ where: { id: replacement.sourceScanId }, select: { bundleId: true } })
    bundle = scan ? await findBundle(tx, { bundleId: scan.bundleId }) : null
  }
  const workOrderId = bundle?.workOrderId ?? replacement?.workOrderId
  if (!workOrderId) throw new ValidationError('Scan the bundle the new panels join.', [{ path: 'body/code', message: 'Scan the bundle’s ticket.' }])
  if (replacement && bundle && replacement.workOrderId !== bundle.workOrderId) refuse({ code: 'REPLACEMENT_OTHER_CELL', message: 'That replacement is of another work order than the bundle.' })
  const order = (await readOrder(tx, workOrderId))!
  // The tablet's ask runs as the system caller: it stays at the tablet's own site.
  if (asker.floor && order.siteId !== asker.floor.siteId) throw new NotFoundError('Bundle not found.')
  const cellId = bundle?.workOrderSizeId ?? replacement!.workOrderSizeId
  const cell = (await readCells(tx, [cellId])).get(cellId)!
  const [cut, live, shadeLots] = await Promise.all([cellCutFacts(tx, cell.id, cell.size), bundle ? liveOf(tx, [bundle]) : Promise.resolve(new Map<string, number>()), bundle ? shadeLotsOf(tx, bundle) : Promise.resolve([] as RecutLot[])])
  const lotRow = body.lotId ? await readLot(tx, body.lotId) : null
  if (body.lotId && (!lotRow || lotRow.siteId !== order.siteId)) throw new ValidationError('Lot not found at this site.', [{ path: 'body/lotId', message: 'Name a lot of the bundle’s site.' }])
  const part = body.part === undefined ? (replacement?.part ?? null) : body.part?.trim() || null
  const quantity = body.quantity ?? replacement?.quantity ?? 0
  if (quantity < 1) throw new ValidationError('Say how many sets to recut.', [{ path: 'body/quantity', message: 'From 1.' }])
  const lot = lotRow ? { id: lotRow.id, code: lotRow.code, itemId: lotRow.itemId, itemColourId: lotRow.itemColourId, dyeBatch: lotRow.dyeBatch, shade: lotRow.shade } : null
  const ruleFacts = {
    workOrder: order,
    bundle: bundle ? { code: bundle.code, status: bundle.status, workOrderSizeId: bundle.workOrderSizeId, live: live.get(bundle.id) ?? bundle.quantity } : null,
    cell: { id: cell.id, label: cellText(cell), parts: cut.parts },
    part,
    quantity,
    lot,
    endBits: body.endBits ?? false,
    materials: cut.materials,
    shadeLots,
    replacement: replacement ? { kind: replacement.kind, status: replacement.status, quantity: replacement.quantity, part: replacement.part, workOrderSizeId: replacement.workOrderSizeId, recutTicketId: (await tx.replacementRequest.findUnique({ where: { id: replacement.id }, select: { recutTicketId: true } }))!.recutTicketId } : null,
  }
  const refusal = recutMakeRefusal(ruleFacts)
  if (refusal) refuse(refusal)
  const id = newId()
  const issued = await allocateNumber(tools, { companyId: order.companyId, kind: 'CUT_TICKET' }, { type: 'CutTicket', id })
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.cutTicket.create({
    data: {
      id,
      companyId: order.companyId,
      siteId: order.siteId,
      number: issued.formatted,
      scanCode: issued.formatted.toUpperCase(),
      kind: 'RECUT',
      workOrderId: order.id,
      workOrderSizeId: cell.id,
      bundleId: bundle?.id ?? null,
      part,
      quantity,
      lotItemId: lot?.itemId ?? null,
      lotId: lot?.id ?? null,
      endBits: body.endBits ?? false,
      createdAt: now,
      updatedAt: now,
      createdById,
    },
    select: { id: true },
  })
  if (replacement) await tx.replacementRequest.update({ where: { id: replacement.id }, data: { recutTicketId: id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  const scope = { companyId: order.companyId, siteId: order.siteId }
  const reason = body.reason.trim()
  const asked = asker.floor ? { askedAt: 'FLOOR', deviceId: asker.floor.deviceId } : { askedAt: 'OFFICE' }
  tools.audit({ action: 'production.makeRecutTicket', recordType: 'CutTicket', recordId: id, ...scope, after: { number: issued.formatted, workOrderSizeId: cell.id, bundleId: bundle?.id ?? null, part, quantity, lotId: lot?.id ?? null, endBits: body.endBits ?? false, replacementId: replacement?.id ?? null, ...asked }, reason })
  tools.audit({ action: 'production.makeRecutTicket', recordType: 'WorkOrder', recordId: order.id, ...scope, after: { recutTicket: issued.formatted, ticketId: id, quantity } })
  if (replacement) tools.audit({ action: 'production.makeRecutTicket', recordType: 'ReplacementRequest', recordId: replacement.id, ...scope, after: { recutTicketId: id, recutTicket: issued.formatted } })
  const row = (await readRecut(tx, id))!
  emitRecut(tools, scope, { ...row, workOrderId: order.id, workOrderSizeId: cell.id, quantity }, order.number, 'MADE', replacement?.id ?? null)
  return { ticket: await viewOf(tx, row, tools.context.audience !== 'system'), warnings: recutWarnings({ lot, shadeLots }) }
}

/** POST /production/recut-tickets: the office's make, or a tablet's ask (numbered by the tenant's system caller). */
export async function makeRecut(caller: CommandCaller, body: MakeBody, idempotencyKey?: string) {
  const context = workerOf(caller)
  if (context.audience === 'floor') {
    if (body.replacementId) throw new ForbiddenError('A recut request of the office is turned into a ticket in the office.')
    if (!idempotencyKey) throw new ValidationError('An Idempotency-Key is required for floor writes.', [{ path: 'headers/idempotency-key', message: 'Required.' }])
    if (!body.code && !body.bundleId) throw new ValidationError('Scan the bundle the new panels join.', [{ path: 'body/code', message: 'Scan the bundle’s ticket.' }])
    // The tablet's own checks: the bundle at its site, its right there, the floor ready.
    const order = await caller.withClient(async (db) => {
      const bundle = await findBundle(db, body)
      return bundle ? readOrder(db, bundle.workOrderId) : null
    })
    seen(context, PRODUCTION_RECUTS, order, 'Bundle')
    await assertFloorReady(caller, context, context.siteId)
    const system = asTenantSystem(caller, context)
    const { result, replayed } = await command(system, { name: 'production.makeRecutTicket', idempotencyKey: `${context.deviceId}.${idempotencyKey}`.slice(0, 128), input: { ...body, deviceId: context.deviceId } }, async (tools) => makeInCommand(tools, body, { floor: context }))
    // The answer is the tablet's view (no replacement: the floor reads none).
    return { ...result, ticket: { ...result.ticket, replacement: null }, replayed }
  }
  const office = officeOf(caller)
  if (body.replacementId) {
    const replacement = await caller.withClient((db) => readReplacement(db, body.replacementId!))
    seen(office, PRODUCTION_RECUTS, replacement, 'Replacement')
  } else {
    const order = await caller.withClient(async (db) => {
      const bundle = await findBundle(db, body)
      return bundle ? readOrder(db, bundle.workOrderId) : null
    })
    if (!body.code && !body.bundleId) throw new ValidationError('Scan or name the bundle the new panels join.', [{ path: 'body/code', message: 'Scan the bundle’s ticket.' }])
    seen(office, PRODUCTION_RECUTS, order, 'Bundle')
  }
  const { result, replayed } = await command(caller, { name: 'production.makeRecutTicket', idempotencyKey, input: body }, async (tools) => makeInCommand(tools, body, { floor: null }))
  return { ...result, replayed }
}

// ---- the label ------------------------------------------------------------------------------------------------------------------

async function labelOf(db: Reader, ticket: RecutRow, language: Language): Promise<RecutLabel> {
  const [order, company, cells, bundles, lot] = await Promise.all([
    readOrder(db, ticket.workOrderId!),
    db.company.findUnique({ where: { id: ticket.companyId }, select: { legalName: true, tradeName: true } }),
    readCells(db, [ticket.workOrderSizeId!]),
    readBundles(db, ticket.bundleId ? [ticket.bundleId] : []),
    ticket.lotId ? readLot(db, ticket.lotId) : Promise.resolve(null),
  ])
  const style = order ? (await readStyles(db, [order.styleId])).get(order.styleId) : undefined
  return {
    code: ticket.scanCode,
    language,
    maker: company?.tradeName || company?.legalName || null,
    workOrderNumber: order?.number ?? '',
    style: style?.code ?? '',
    cell: cellText(cells.get(ticket.workOrderSizeId!)),
    part: ticket.part,
    quantity: ticket.quantity!,
    bundleCode: ticket.bundleId ? (bundles.get(ticket.bundleId)?.code ?? null) : null,
    lotCode: lot?.code ?? null,
    endBits: ticket.endBits,
    due: day(order?.dueDate ?? null),
  }
}

export interface PrintBody {
  readonly printerId?: string | null | undefined
  readonly copies?: number | undefined
  readonly language?: Language | undefined
}

/** POST /production/recut-tickets/:ticketId/print: the label on a label printer of the site (the station's, the site's only one). */
export async function printRecut(caller: CommandCaller, ticketId: string, body: PrintBody, idempotencyKey?: string) {
  const context = workerOf(caller)
  const ticket = await caller.withClient((db) => readRecut(db, ticketId))
  if (!ticket || ticket.kind !== 'RECUT') throw new NotFoundError('Recut ticket not found.')
  seen(context, PRODUCTION_CUT, ticket, 'Recut ticket')
  if (ticket.status === 'DONE' || ticket.status === 'VOID') refuse({ code: ticket.status === 'DONE' ? 'TICKET_DONE' : 'TICKET_VOID', message: `Recut ticket ${ticket.number} is ${ticket.status.toLowerCase()}: it is not printed again.` })
  const language = body.language ?? 'it'
  const label = await caller.withClient((db) => labelOf(db, ticket, language))
  const target = await labelTarget(caller, context, { siteId: ticket.siteId, stationPrinterId: null }, body.printerId)
  const copies = body.copies ?? 1
  const queued = await queueLabel(caller, target, { recordType: 'CutTicket', recordId: ticket.id, kind: CUT_TICKET_LABEL_KIND, scanId: ticket.scanCode, copies, zplFor: (stock) => recutZpl(label, stock, copies) }, jobKey('recut-ticket', ticket.id, idempotencyKey))
  let printed = await caller.withClient((db) => viewOf(db, ticket, context.audience === 'office'))
  if (queued.job) {
    const { result } = await command(caller, { name: 'production.printRecutTicket', idempotencyKey, input: { ticketId, ...body }, record: { type: 'CutTicket', id: ticket.id } }, async (tools) => {
      const { tx, now } = tools
      await tx.cutTicket.update({ where: { id: ticket.id }, data: { printedAt: now, updatedAt: now }, select: { id: true } })
      const order = (await readOrder(tx, ticket.workOrderId!))!
      tools.audit({ action: 'production.printRecutTicket', recordType: 'CutTicket', recordId: ticket.id, companyId: ticket.companyId, siteId: ticket.siteId, after: { printedAt: now.toISOString(), jobId: queued.job!.id, copies } })
      const row = (await readRecut(tx, ticket.id))!
      emitRecut(tools, ticket, { ...row, workOrderId: row.workOrderId!, workOrderSizeId: row.workOrderSizeId!, quantity: row.quantity! }, order.number, 'PRINTED')
      return viewOf(tx, row, context.audience === 'office')
    })
    printed = result
  }
  return { ticket: printed, label: recutLines(label), job: queued.job, problem: queued.problem }
}

// ---- at the cutting table --------------------------------------------------------------------------------------------------------

/** The scans lock the ticket's row (a DONE or VOID ticket never changes, not even its version: refused in words first). */
async function lockRecut(tx: CommandTx, ticketId: string): Promise<RecutRow> {
  await tx.$queryRaw`SELECT 1 FROM "CutTicket" WHERE id = ${ticketId}::uuid FOR UPDATE`
  return (await readRecut(tx, ticketId))!
}

/** A work order held by quality (an active hold): nothing is recut for it. */
async function qualityHold(tx: CommandTx, order: OrderRow) {
  const holds = await activeHoldsOf(tx, 'WorkOrder', [order.id])
  return holds.length > 0 ? { code: 'WORK_ORDER_ON_HOLD' as const, message: `Work order ${order.number} is on hold by quality: no panel is recut for it until the hold is lifted.` } : null
}

async function scanned(caller: CommandCaller, code: string) {
  const context = floorOf(caller)
  const ticket = await caller.withClient((db) => recutByCode(db, context, code))
  await assertFloorReady(caller, context, ticket.siteId)
  return ticket
}

/** POST /production/recut-tickets/start: the cutter's start scan (OPEN → STARTED). */
export async function startRecut(caller: CommandCaller, body: { readonly code: string }, idempotencyKey?: string) {
  const ticket = await scanned(caller, body.code)
  const { result, replayed } = await command(caller, { name: 'production.startRecutTicket', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRecut(tx, ticket.id)
    const { order, bundle } = await scanFacts(tx, current)
    const refusal = recutStartRefusal(facts(current), order, bundle ? { code: bundle.code, status: bundle.status } : null) ?? (await qualityHold(tx, order))
    if (refusal) refuse(refusal)
    await tx.cutTicket.update({ where: { id: current.id }, data: { status: 'STARTED', startedAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'production.startRecutTicket', recordType: 'CutTicket', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: 'STARTED' } })
    const row = (await readRecut(tx, current.id))!
    emitRecut(tools, current, { ...row, workOrderId: row.workOrderId!, workOrderSizeId: row.workOrderSizeId!, quantity: row.quantity! }, order.number, 'STARTED')
    return cardOf(tx, row, false)
  })
  return { ...result, replayed }
}

/** POST /production/recut-tickets/finish: the end scan (STARTED → DONE): the panels join their bundle (its genealogy). */
export async function finishRecut(caller: CommandCaller, body: { readonly code: string }, idempotencyKey?: string) {
  const ticket = await scanned(caller, body.code)
  const { result, replayed } = await command(caller, { name: 'production.finishRecutTicket', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockRecut(tx, ticket.id)
    const refusal = recutFinishRefusal(facts(current))
    if (refusal) refuse(refusal)
    const { order, bundle } = await scanFacts(tx, current)
    await tx.cutTicket.update({ where: { id: current.id }, data: { status: 'DONE', doneAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const scope = { companyId: current.companyId, siteId: current.siteId }
    tools.audit({ action: 'production.finishRecutTicket', recordType: 'CutTicket', recordId: current.id, ...scope, before: { status: current.status }, after: { status: 'DONE', bundleId: current.bundleId } })
    if (bundle) tools.audit({ action: 'production.finishRecutTicket', recordType: 'Bundle', recordId: bundle.id, ...scope, after: { recutJoined: { ticketId: current.id, number: current.number, part: current.part, quantity: current.quantity } } })
    const row = (await readRecut(tx, current.id))!
    emitRecut(tools, current, { ...row, workOrderId: row.workOrderId!, workOrderSizeId: row.workOrderSizeId!, quantity: row.quantity! }, order.number, 'DONE')
    return cardOf(tx, row, false)
  })
  return { ...result, replayed }
}

/** POST /production/recut-tickets/:ticketId/void: the office voids a lost or wrong one with the reason. */
export async function voidRecut(caller: CommandCaller, ticketId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const ticket = await caller.withClient((db) => readRecut(db, ticketId))
  if (!ticket || ticket.kind !== 'RECUT') throw new NotFoundError('Recut ticket not found.')
  seen(context, PRODUCTION_RECUTS, ticket, 'Recut ticket')
  if (ticket.status === 'DONE' || ticket.status === 'VOID') refuse({ code: ticket.status === 'DONE' ? 'TICKET_DONE' : 'TICKET_VOID', message: `Recut ticket ${ticket.number} is ${ticket.status.toLowerCase()}: it is not voided.` })
  const { result } = await command(caller, { name: 'production.voidRecutTicket', idempotencyKey, input: { ticketId, ...body }, record: { type: 'CutTicket', id: ticketId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await readRecut(tx, ticketId))!
    if (current.status === 'DONE' || current.status === 'VOID') refuse({ code: current.status === 'DONE' ? 'TICKET_DONE' : 'TICKET_VOID', message: `Recut ticket ${current.number} is ${current.status.toLowerCase()}: it is not voided.` })
    const reason = body.reason.trim()
    await tx.cutTicket.update({ where: { id: ticketId }, data: { status: 'VOID', voidedAt: now, voidReason: reason, updatedAt: now }, select: { id: true } })
    const order = (await readOrder(tx, current.workOrderId!))!
    tools.audit({ action: 'production.voidRecutTicket', recordType: 'CutTicket', recordId: ticketId, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: 'VOID' }, reason })
    const row = (await readRecut(tx, ticketId))!
    emitRecut(tools, current, { ...row, workOrderId: row.workOrderId!, workOrderSizeId: row.workOrderSizeId!, quantity: row.quantity! }, order.number, 'VOIDED')
    return { ticket: await viewOf(tx, row, true) }
  })
  return result
}
