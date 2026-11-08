import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_SECONDARY } from '@nexus/factory-domain/production/cutissue/permissions'
import {
  addRefusal,
  kindWords,
  moveRefusal,
  nextProcessOf,
  pendingOf,
  pendingWords,
  SECONDARY_LIMITS,
  type SecondaryKind,
  type SecondaryMove,
  type SecondaryPlace,
  type SecondaryStatus,
} from '@nexus/factory-domain/production/cutissue/secondary'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { assertFloorReady } from '../bundles/bundles'
import { officeOf, refuse, seen, workerOf } from './access'
import { emitProcess } from './emit'
import { deviceStation, findBundle, liveOf, PROCESS_COLUMNS, readBundles, readCells, readOrder, readOrders, readProcesses, readWorkCentres, trolleyOfBundles, type ProcessRow, type Reader } from './store'

/**
 * Secondary processes after cutting (B-W2b-117; MES-047; design floor.fabriccut "Send to sewing": "Secondary processes (fusing,
 * perforation, embroidery) as a route step"; rules factory-domain production/cutissue/secondary):
 *
 *   GET  /production/secondary-processes              office (production.cutting.view): every process, newest first; tiles
 *   GET  /production/secondary-processes/bundle       office + floor (production.secondary): a scanned bundle's processes and
 *                                                     what the scan does next at this tablet's work centre (one tap after it)
 *   POST /production/secondary-processes              office + floor (production.secondary): give bundles a process (WAITING)
 *   POST /production/secondary-processes/:id/start    WAITING → IN_PROGRESS (outside: sent under its subcontract order, office)
 *   POST /production/secondary-processes/:id/done     IN_PROGRESS → DONE
 *   POST /production/secondary-processes/:id/cancel   WAITING | IN_PROGRESS → CANCELLED with the reason
 *
 * Each write is ONE command (a tablet's with its Idempotency-Key): an add under each bundle's lock (its processes' places and
 * one open process of a kind), a move on the process's version (command()'s bump; a tablet sends none). Audited (the process
 * and its bundle), with secondary_process.changed. A floor session reads no subcontract order (its fee is money): the office
 * names one when it sends an outside process. No worker is named.
 */

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

/** The views of processes (the subcontract order only for the office). */
async function processViews(db: Reader, rows: readonly ProcessRow[], office: boolean) {
  const [orders, bundles, centres] = await Promise.all([
    readOrders(db, rows.map((row) => row.workOrderId)),
    readBundles(db, rows.map((row) => row.bundleId)),
    readWorkCentres(db, rows.flatMap((row) => (row.workCentreId ? [row.workCentreId] : []))),
  ])
  const cells = await readCells(db, [...bundles.values()].map((bundle) => bundle.workOrderSizeId))
  const orderIds = office ? [...new Set(rows.flatMap((row) => (row.subcontractOrderId ? [row.subcontractOrderId] : [])))] : []
  const subcontracts = new Map(orderIds.length > 0 ? (await db.subcontractOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, status: true } })).map((row) => [row.id, row]) : [])
  return rows.map((row) => {
    const order = orders.get(row.workOrderId)
    const bundle = bundles.get(row.bundleId)
    const cell = bundle ? cells.get(bundle.workOrderSizeId) : undefined
    const centre = row.workCentreId ? centres.get(row.workCentreId) : undefined
    const subcontract = row.subcontractOrderId ? subcontracts.get(row.subcontractOrderId) : undefined
    return {
      id: row.id,
      workOrder: { id: row.workOrderId, number: order?.number ?? '', status: order?.status ?? 'RELEASED' },
      bundle: { id: row.bundleId, code: bundle?.code ?? '', part: bundle?.part ?? null },
      cell: { id: bundle?.workOrderSizeId ?? row.bundleId, colourwayCode: cell?.colourwayCode ?? '', size: cell?.size ?? '' },
      seq: row.seq,
      kind: row.kind as SecondaryKind,
      words: { it: kindWords(row.kind as SecondaryKind, 'it'), en: kindWords(row.kind as SecondaryKind, 'en') },
      place: row.place as SecondaryPlace,
      workCentre: centre ? { id: centre.id, code: centre.code, name: centre.name } : null,
      subcontractOrder: subcontract ? { id: subcontract.id, number: subcontract.number, status: subcontract.status } : null,
      quantity: row.quantity,
      status: row.status as SecondaryStatus,
      startedAt: at(row.startedAt),
      doneAt: at(row.doneAt),
      cancelledAt: at(row.cancelledAt),
      cancelReason: row.cancelReason,
      note: row.note,
      createdAt: toUtcIso(row.createdAt),
      version: row.version,
    }
  })
}

async function readProcess(db: Reader, processId: string): Promise<ProcessRow | null> {
  if (!isUuid(processId)) return null
  return db.secondaryProcess.findUnique({ where: { id: processId }, select: PROCESS_COLUMNS })
}

// ---- lists ----------------------------------------------------------------------------------------------------------------------

export const PROCESS_VIEWS = ['open', 'waiting', 'in_progress', 'done', 'cancelled', 'all'] as const
export type ProcessListView = (typeof PROCESS_VIEWS)[number]
const VIEW_STATUSES: Record<ProcessListView, readonly SecondaryStatus[] | null> = { open: ['WAITING', 'IN_PROGRESS'], waiting: ['WAITING'], in_progress: ['IN_PROGRESS'], done: ['DONE'], cancelled: ['CANCELLED'], all: null }

export interface ProcessListQuery {
  readonly view?: ProcessListView | undefined
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly workCentreId?: string | undefined
  readonly kind?: SecondaryKind | undefined
  readonly place?: SecondaryPlace | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** GET /production/secondary-processes: the office's list, newest first, with a tile per status. */
export async function listProcesses(caller: CommandCaller, query: ProcessListQuery) {
  const context = officeOf(caller)
  // A process has no company column: the caller's scope reaches it through its bundle's work order.
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput
  const limit = Math.min(query.limit ?? 50, SECONDARY_LIMITS.rows)
  const base: Prisma.SecondaryProcessWhereInput[] = [
    { bundle: { is: { workOrder: { is: scope } } } },
    query.siteId ? { siteId: query.siteId } : {},
    query.workOrderId ? { workOrderId: query.workOrderId } : {},
    query.workCentreId ? { workCentreId: query.workCentreId } : {},
    query.kind ? { kind: query.kind } : {},
    query.place ? { place: query.place } : {},
  ]
  const statuses = VIEW_STATUSES[query.view ?? 'open']
  return caller.withClient(async (db) => {
    const rows = await db.secondaryProcess.findMany({
      where: { AND: [...base, statuses ? { status: { in: [...statuses] } } : {}, query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {}] },
      select: PROCESS_COLUMNS,
      orderBy: { id: 'desc' },
      take: limit + 1,
    })
    const page = rows.slice(0, limit)
    const counts = await db.secondaryProcess.groupBy({ by: ['status'], where: { AND: base }, _count: { _all: true } })
    const count = (status: SecondaryStatus) => counts.find((row) => row.status === status)?._count._all ?? 0
    return {
      rows: await processViews(db, page, true),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      tiles: { waiting: count('WAITING'), inProgress: count('IN_PROGRESS'), done: count('DONE'), cancelled: count('CANCELLED') },
    }
  })
}

/** GET /production/secondary-processes/bundle?code=|bundleId=: a bundle's processes and what the scan does next here. */
export async function bundleProcesses(caller: CommandCaller, query: { readonly code?: string | undefined; readonly bundleId?: string | undefined }) {
  const context = workerOf(caller)
  if (!query.code && !query.bundleId) throw new ValidationError('Scan the bundle, or name it.', [{ path: 'querystring/code', message: 'Scan the bundle’s ticket.' }])
  return caller.withClient(async (db) => {
    const bundle = await findBundle(db, query)
    const order = seen(context, PRODUCTION_SECONDARY, bundle ? await readOrder(db, bundle.workOrderId) : null, 'Bundle')
    const [rows, live, cells, station, trolleys] = await Promise.all([
      readProcesses(db, [bundle!.id]),
      liveOf(db, [bundle!]),
      readCells(db, [bundle!.workOrderSizeId]),
      context.audience === 'floor' ? deviceStation(db, context.deviceId) : Promise.resolve(null),
      trolleyOfBundles(db, [bundle!.id], true),
    ])
    const processes = await processViews(db, rows, context.audience === 'office')
    const next = nextProcessOf(rows.map((row) => ({ ...row, kind: row.kind as SecondaryKind, place: row.place as SecondaryPlace, status: row.status as SecondaryStatus })), station?.workCentreId ?? null)
    const pending = pendingOf(rows.map((row) => ({ ...row, kind: row.kind as SecondaryKind, place: row.place as SecondaryPlace, status: row.status as SecondaryStatus })))
    const nextWords = next ? { it: `${next.move === 'start' ? 'Inizia' : 'Finisci'}: ${kindWords(next.process.kind, 'it')}`, en: `${next.move === 'start' ? 'Start' : 'Finish'} ${kindWords(next.process.kind, 'en')}` } : null
    return {
      bundle: { id: bundle!.id, code: bundle!.code, part: bundle!.part, status: bundle!.status as 'ACTIVE' | 'VOID', live: live.get(bundle!.id) ?? bundle!.quantity },
      workOrder: { id: order.id, number: order.number, status: order.status },
      cell: { id: bundle!.workOrderSizeId, colourwayCode: cells.get(bundle!.workOrderSizeId)?.colourwayCode ?? '', size: cells.get(bundle!.workOrderSizeId)?.size ?? '' },
      processes,
      next: next ? { processId: next.process.id, move: next.move, words: nextWords! } : null,
      /** Why it does not go to sewing yet (null: every process passed). */
      toSewing: pending.length > 0 ? { it: pendingWords(bundle!.code, pending, 'it')!, en: pendingWords(bundle!.code, pending, 'en')! } : null,
      trolley: trolleys.get(bundle!.id) ? { trolleyCode: trolleys.get(bundle!.id)!.trolleyCode, status: trolleys.get(bundle!.id)!.status } : null,
    }
  })
}

// ---- add ------------------------------------------------------------------------------------------------------------------------

export interface AddBody {
  readonly bundles: readonly { readonly code?: string | undefined; readonly bundleId?: string | undefined }[]
  readonly kind: SecondaryKind
  readonly place: SecondaryPlace
  readonly workCentreId?: string | null | undefined
  readonly quantity?: number | undefined
  readonly note?: string | null | undefined
}

/** Each bundle's processes take turns: their places and one open process of a kind are read under it. */
async function lockBundles(tx: CommandTx, tenantId: string, bundleIds: readonly string[]): Promise<void> {
  for (const bundleId of [...new Set(bundleIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.secondary-process', ${tenantId}::uuid, ${bundleId}::uuid), 0))`
  }
}

/** POST /production/secondary-processes: one process of a kind for each bundle named, WAITING. */
export async function addProcesses(caller: CommandCaller, body: AddBody, idempotencyKey?: string) {
  const context = workerOf(caller)
  const known = await caller.withClient(async (db) => {
    const rows = []
    for (const [index, by] of body.bundles.entries()) {
      const bundle = await findBundle(db, by)
      if (!bundle) throw new NotFoundError(`Bundle ${by.code ?? by.bundleId ?? ''} not found (line ${index + 1}).`)
      seen(context, PRODUCTION_SECONDARY, await readOrder(db, bundle.workOrderId), 'Bundle')
      rows.push(bundle)
    }
    return rows
  })
  if (new Set(known.map((bundle) => bundle.id)).size !== known.length) throw new ValidationError('A bundle is named twice.', [{ path: 'body/bundles', message: 'Each bundle once.' }])
  if (context.audience === 'floor') await assertFloorReady(caller, context, context.siteId)
  const { result, replayed } = await command(caller, { name: 'production.addSecondaryProcess', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockBundles(tx, context.tenantId, known.map((bundle) => bundle.id))
    const bundles = await readBundles(tx, known.map((bundle) => bundle.id))
    const [orders, live, processes, trolleys] = await Promise.all([readOrders(tx, known.map((bundle) => bundle.workOrderId)), liveOf(tx, [...bundles.values()]), readProcesses(tx, [...bundles.keys()]), trolleyOfBundles(tx, [...bundles.keys()], true)])
    const centre = body.workCentreId ? (await readWorkCentres(tx, [body.workCentreId])).get(body.workCentreId) : undefined
    if (body.workCentreId && !centre) throw new ValidationError('Work centre not found.', [{ path: 'body/workCentreId', message: 'Name a work centre of the site.' }])
    const made: ProcessRow[] = []
    for (const known1 of known) {
      const bundle = bundles.get(known1.id)!
      const order = orders.get(bundle.workOrderId)!
      const own = processes.filter((row) => row.bundleId === bundle.id)
      const quantity = body.quantity ?? live.get(bundle.id) ?? bundle.quantity
      const refusal = addRefusal({
        workOrder: order,
        bundle: { code: bundle.code, status: bundle.status, live: live.get(bundle.id) ?? bundle.quantity },
        kind: body.kind,
        place: body.place,
        quantity,
        workCentre: centre ? { code: centre.code, ok: centre.siteId === bundle.siteId && centre.status === 'ACTIVE' } : null,
        processes: own.map((row) => ({ kind: row.kind as SecondaryKind, place: row.place as SecondaryPlace, status: row.status as SecondaryStatus })),
        onTrolley: trolleys.get(bundle.id)?.trolleyCode ?? null,
      })
      if (refusal) refuse(refusal)
      const id = newId()
      const seq = Math.max(0, ...own.map((row) => row.seq)) + SECONDARY_LIMITS.seqStep
      await tx.secondaryProcess.create({
        data: { id, siteId: bundle.siteId, workOrderId: bundle.workOrderId, bundleId: bundle.id, seq, kind: body.kind, place: body.place, workCentreId: body.place === 'IN_HOUSE' ? (centre?.id ?? null) : null, quantity, note: body.note?.trim() || null, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null },
        select: { id: true },
      })
      const row = (await readProcess(tx, id))!
      made.push(row)
      const scope = { companyId: order.companyId, siteId: order.siteId }
      tools.audit({ action: 'production.addSecondaryProcess', recordType: 'SecondaryProcess', recordId: id, ...scope, after: { bundleId: bundle.id, seq, kind: body.kind, place: body.place, workCentreId: row.workCentreId, quantity } })
      tools.audit({ action: 'production.addSecondaryProcess', recordType: 'Bundle', recordId: bundle.id, ...scope, after: { secondaryProcess: { id, kind: body.kind, place: body.place } } })
      emitProcess(tools, scope, row, order.number, 'ADDED')
    }
    return { processes: await processViews(tx, made, context.audience === 'office') }
  })
  return { ...result, replayed }
}

// ---- moves ----------------------------------------------------------------------------------------------------------------------

export interface MoveBody {
  readonly version?: number | undefined
  /** start, in house: the work centre it is done at (when it had none, or another). */
  readonly workCentreId?: string | undefined
  /** start, outside (office): the subcontract order it is sent under. */
  readonly subcontractOrderId?: string | undefined
  /** cancel: why. */
  readonly reason?: string | undefined
}

const NAME: Record<SecondaryMove, Permission> = { start: 'production.startSecondaryProcess', done: 'production.finishSecondaryProcess', cancel: 'production.cancelSecondaryProcess' }
const STATUS: Record<SecondaryMove, SecondaryStatus> = { start: 'IN_PROGRESS', done: 'DONE', cancel: 'CANCELLED' }
const CHANGE = { start: 'STARTED', done: 'DONE', cancel: 'CANCELLED' } as const

/** POST /production/secondary-processes/:processId/start|done|cancel. */
export async function moveProcess(caller: CommandCaller, processId: string, move: SecondaryMove, body: MoveBody, idempotencyKey?: string) {
  const context = workerOf(caller)
  if (move === 'cancel' && !body.reason?.trim()) throw new ValidationError('Say why the process is cancelled.', [{ path: 'body/reason', message: 'Required.' }])
  const known = await caller.withClient((db) => readProcess(db, processId))
  const order = known ? await caller.withClient((db) => readOrder(db, known.workOrderId)) : null
  seen(context, PRODUCTION_SECONDARY, order, 'Secondary process')
  if (context.audience === 'floor') await assertFloorReady(caller, context as FloorContext, context.siteId)
  const record = { type: 'SecondaryProcess' as const, id: processId, ...(body.version !== undefined ? { expectedVersion: body.version } : {}) }
  const { result, replayed } = await command(caller, { name: NAME[move], idempotencyKey, input: { processId, move, ...body }, record }, async (tools) => {
    const { tx, now } = tools
    const current = (await readProcess(tx, processId))!
    const work = (await readOrder(tx, current.workOrderId))!
    const bundle = (await readBundles(tx, [current.bundleId])).get(current.bundleId)!
    const workCentreId = move === 'start' && current.place === 'IN_HOUSE' ? (body.workCentreId ?? current.workCentreId) : current.workCentreId
    const centre = workCentreId ? (await readWorkCentres(tx, [workCentreId])).get(workCentreId) : undefined
    if (workCentreId && !centre) throw new ValidationError('Work centre not found.', [{ path: 'body/workCentreId', message: 'Name a work centre of the site.' }])
    const subcontract =
      move === 'start' && current.place === 'OUTSIDE' && context.audience === 'office' && body.subcontractOrderId
        ? await tx.subcontractOrder.findUnique({ where: { id: body.subcontractOrderId }, select: { id: true, number: true, status: true, workOrderId: true } })
        : null
    if (move === 'start' && body.subcontractOrderId && context.audience === 'office' && !subcontract) throw new ValidationError('Subcontract order not found.', [{ path: 'body/subcontractOrderId', message: 'Name a subcontract order of the work order.' }])
    const refusal = moveRefusal(move, {
      workOrder: work,
      process: { kind: current.kind as SecondaryKind, place: current.place as SecondaryPlace, status: current.status as SecondaryStatus, bundleCode: bundle.code },
      floor: context.audience === 'floor',
      workCentre: centre ? { code: centre.code, ok: centre.siteId === current.siteId && centre.status === 'ACTIVE' } : null,
      subcontract: subcontract ? { number: subcontract.number, sameWorkOrder: subcontract.workOrderId === current.workOrderId, status: subcontract.status } : null,
    })
    if (refusal) refuse(refusal)
    const status = STATUS[move]
    const data: Prisma.SecondaryProcessUncheckedUpdateInput = {
      status,
      updatedAt: now,
      ...(move === 'start' ? { startedAt: now, ...(current.place === 'IN_HOUSE' ? { workCentreId: workCentreId ?? null } : { subcontractOrderId: subcontract!.id }) } : {}),
      ...(move === 'done' ? { doneAt: now } : {}),
      ...(move === 'cancel' ? { cancelledAt: now, cancelReason: body.reason!.trim() } : {}),
    }
    await tx.secondaryProcess.update({ where: { id: processId }, data, select: { id: true } })
    const scope = { companyId: work.companyId, siteId: work.siteId }
    tools.audit({
      action: NAME[move],
      recordType: 'SecondaryProcess',
      recordId: processId,
      ...scope,
      before: { status: current.status },
      after: { status, ...(move === 'start' ? { workCentreId: current.place === 'IN_HOUSE' ? (workCentreId ?? null) : null, subcontractOrderId: subcontract?.id ?? null } : {}) },
      ...(move === 'cancel' ? { reason: body.reason!.trim() } : {}),
    })
    const row = (await readProcess(tx, processId))!
    emitProcess(tools, scope, row, work.number, CHANGE[move])
    const [view] = await processViews(tx, [row], context.audience === 'office')
    return { process: view! }
  })
  return { ...result, replayed }
}
