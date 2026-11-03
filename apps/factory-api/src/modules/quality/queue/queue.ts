import { Dec } from '@nexus/factory-domain/tax/decimal'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { inspectedOf } from '@nexus/factory-domain/quality/final/plan'
import { sampleWords } from '@nexus/factory-domain/quality/incoming/rules'
import {
  blockOf,
  garmentsToInspect,
  isMine,
  KIND_WORDS,
  oldestWaitingSince,
  queueOrder,
  takenOf,
  waitingOf,
  type Block,
  type QueueKind,
  type QueueRecordType,
  type ScanStage,
  type Taken,
  type Words,
} from '@nexus/factory-domain/quality/queue/rules'
import type { FactoryClient } from '@nexus/factory-db'
import type { CommandCaller } from '../../../core/command'
import { benchWorkOrders } from '../final/bench'
import { PERMISSIONS, may, scopeOf, viewerOf, type Viewer } from './access'

/**
 * The inspector queue (B-W2b-106; QHS-068; design floor.mywork "inspector queue (W2b, QHS-068: blocking lots first, waiting
 * time)", quality.inspections "Due"). One list of every due inspection the viewer may see:
 *
 *   FINAL        an OPEN final inspection (B-W1-45, on a plan B-W2b-97): it holds the release of its lot's garments
 *   FINAL_DUE    a work order whose finished garments are neither released nor in an open inspection (B-W1-45's bench
 *                list): a rule cannot open a final inspection (B-W2b-101's gap), so the queue shows the garments that wait
 *   INCOMING     an OPEN incoming inspection (B-W2b-98; a rule opens one at goods receipt, B-W2b-101): its lot waits in
 *                quarantine, maybe needed by work orders
 *   FIRST_PIECE, CUTTING, ROVING, END_OF_LINE   an OPEN in-process check (B-W2b-99; a rule opens them, B-W2b-101): a first
 *                piece holds its run
 *
 * Sorted by factory-domain quality/queue (what each holds up, the day the work that waits needs it, how long it has waited).
 * scope `mine` (the default): the viewer's own and those nobody took yet; `all`: everything the viewer may see. A row names
 * nobody: whose it is is MINE, NOBODY or OTHER (Owner answer W1; Statuto dei Lavoratori art. 4), and no figure is per person.
 * Read only.
 */

export interface QueueQuery {
  readonly scope: 'mine' | 'all'
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly kind?: QueueKind | undefined
  readonly limit: number
}

export interface QueueRow {
  readonly key: string
  readonly kind: QueueKind
  readonly kindWords: Words
  readonly recordType: QueueRecordType | null
  readonly id: string | null
  readonly number: string | null
  readonly title: string
  readonly companyId: string
  readonly siteId: string
  readonly workOrder: { readonly id: string; readonly number: string } | null
  readonly lot: { readonly id: string; readonly code: string; readonly qualityStatus: string } | null
  readonly item: { readonly code: string; readonly name: string } | null
  readonly bundle: { readonly id: string; readonly code: string } | null
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string } | null
  readonly plan: { readonly code: string; readonly number: number } | null
  readonly progress: { readonly done: number | null; readonly of: number | null; readonly words: Words } | null
  readonly openedAt: string | null
  readonly waitingSince: string | null
  readonly waiting: { readonly minutes: number; readonly words: Words } | null
  readonly dueAt: string | null
  readonly overdue: boolean
  readonly blocks: Block
  readonly taken: Taken
  readonly may: { readonly record: boolean; readonly start: boolean }
  readonly open: { readonly method: 'GET'; readonly path: string } | null
  readonly start: { readonly code: string; readonly stage: ScanStage } | null
  readonly version: number | null
}

/** Rows looked at per kind: the oldest open records first, so a long wait is never cut off. */
const PER_KIND = 500
/** Work orders of the bench list looked at for garments that wait. */
const DUE_WORK_ORDERS = 50
const OPEN_WORK = ['RELEASED', 'IN_PROGRESS'] as const

const iso = (value: Date | null | undefined): string | null => (value ? toUtcIso(value) : null)
const dayOf = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
const fixed = (value: { toString(): string }): string => new Dec(value.toString()).toFixed()

function rowOf(base: Omit<QueueRow, 'kindWords' | 'waiting' | 'overdue'>, now: Date): QueueRow {
  return {
    ...base,
    kindWords: KIND_WORDS[base.kind],
    waiting: base.waitingSince ? waitingOf(new Date(base.waitingSince), now) : null,
    overdue: base.dueAt !== null && Date.parse(base.dueAt) < now.getTime(),
  }
}

// ---- final inspections, and garments that wait for one -----------------------------------------------------------------------------

const finalRows = (caller: CommandCaller, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> => caller.withClient((db) => finalRowsIn(db, viewer, query, now, today))

async function finalRowsIn(db: FactoryClient, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> {
  const rows = await db.inspection.findMany({
    where: { AND: [scopeOf(viewer, PERMISSIONS.final.view, query), { status: 'OPEN' }] },
    select: { id: true, number: true, companyId: true, siteId: true, workOrderId: true, lotSize: true, sampleSize: true, checklist: true, planVersionId: true, inspectorWorkerId: true, inspectorUserId: true, assignedInspectorId: true, assignedInspectorWorkerId: true, dueAt: true, createdAt: true, version: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PER_KIND,
  })
  if (rows.length === 0) return []
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId))] } }, select: { id: true, number: true, dueDate: true, style: { select: { code: true, name: true } } } })).map((order) => [order.id, order]))
  const versions = new Map((await db.inspectionPlanVersion.findMany({ where: { id: { in: rows.map((row) => row.planVersionId).filter((value): value is string => value !== null) } }, select: { id: true, number: true, plan: { select: { code: true } } } })).map((version) => [version.id, version]))
  return rows.map((row) => {
    const order = orders.get(row.workOrderId)
    const number = order?.number ?? '—'
    const taken = takenOf({ workerId: row.inspectorWorkerId, userId: row.inspectorUserId }, viewer.person, { workerId: row.assignedInspectorWorkerId, userId: row.assignedInspectorId })
    const version = row.planVersionId ? versions.get(row.planVersionId) : undefined
    const done = row.planVersionId ? inspectedOf(row.checklist) : null
    return rowOf(
      {
        key: `Inspection:${row.id}`,
        kind: 'FINAL',
        recordType: 'Inspection',
        id: row.id,
        number: row.number,
        title: [number, order ? `${order.style.code} ${order.style.name}` : null].filter(Boolean).join(' · '),
        companyId: row.companyId,
        siteId: row.siteId,
        workOrder: { id: row.workOrderId, number },
        lot: null,
        item: order ? { code: order.style.code, name: order.style.name } : null,
        bundle: null,
        operation: null,
        plan: version ? { code: version.plan.code, number: version.number } : null,
        progress:
          done === null
            ? { done: null, of: row.sampleSize, words: { it: `Campione di ${row.sampleSize} su ${row.lotSize}`, en: `Sample of ${row.sampleSize} of ${row.lotSize}` } }
            : { done, of: row.sampleSize, words: { it: `${done} di ${row.sampleSize} controllati`, en: `${done} of ${row.sampleSize} inspected` } },
        openedAt: iso(row.createdAt),
        waitingSince: iso(row.createdAt),
        dueAt: iso(row.dueAt),
        blocks: blockOf({ kind: 'FINAL', workOrder: number, garments: row.lotSize, dueDate: dayOf(order?.dueDate) }, today),
        taken,
        may: { record: taken === 'MINE' && may(viewer, PERMISSIONS.final.record, row), start: false },
        open: { method: 'GET', path: row.planVersionId ? `/quality/inspections/${row.id}/sheet` : `/quality/inspections/${row.id}` },
        start: null,
        version: row.version,
      },
      now,
    )
  })
}

/**
 * Since when a work order's garments wait for a final inspection: the time the oldest garment no inspection covers was
 * finished (good at its last operation; an undone report left out), garments taken first in, first out by the releases and
 * the open inspections (factory-domain `oldestWaitingSince`).
 */
async function waitingSinceOf(db: FactoryClient, covered: ReadonlyMap<string, number>): Promise<Map<string, Date | null>> {
  const workOrderIds = [...covered.keys()]
  const last = new Map<string, { id: string; seq: number }>()
  for (const operation of await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, seq: true } })) {
    const known = last.get(operation.workOrderId)
    if (!known || operation.seq > known.seq) last.set(operation.workOrderId, { id: operation.id, seq: operation.seq })
  }
  const since = new Map<string, Date | null>()
  for (const workOrderId of workOrderIds) {
    const operation = last.get(workOrderId)
    if (!operation) {
      since.set(workOrderId, null)
      continue
    }
    const scans = await db.operationScan.findMany({ where: { workOrderOperationId: operation.id, kind: { in: ['REPORT', 'UNDO'] } }, select: { id: true, kind: true, correctsId: true, goodQuantity: true, serverTime: true }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
    const undone = new Set(scans.filter((scan) => scan.kind === 'UNDO' && scan.correctsId).map((scan) => scan.correctsId!))
    const reports = scans.filter((scan) => scan.kind === 'REPORT' && !undone.has(scan.id)).map((scan) => ({ at: toUtcIso(scan.serverTime), good: scan.goodQuantity }))
    const at = oldestWaitingSince(reports, covered.get(workOrderId) ?? 0)
    since.set(workOrderId, at ? new Date(at) : null)
  }
  return since
}

async function dueRows(caller: CommandCaller, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> {
  const bench = (await benchWorkOrders(caller, { limit: DUE_WORK_ORDERS })).workOrders.filter((order) => order.ready && (!query.siteId || order.siteId === query.siteId))
  if (bench.length === 0) return []
  return caller.withClient((db) => dueRowsIn(db, bench, viewer, query, now, today))
}

type BenchRow = Awaited<ReturnType<typeof benchWorkOrders>>['workOrders'][number]

async function dueRowsIn(db: FactoryClient, bench: readonly BenchRow[], viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> {
  const ids = bench.map((order) => order.id)
  const companies = new Map((await db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true } })).map((order) => [order.id, order.companyId]))
  const inOpen = new Map<string, number>()
  for (const open of await db.inspection.findMany({ where: { workOrderId: { in: ids }, status: 'OPEN' }, select: { workOrderId: true, lotSize: true } })) inOpen.set(open.workOrderId, (inOpen.get(open.workOrderId) ?? 0) + open.lotSize)
  const since = await waitingSinceOf(db, new Map(bench.map((order) => [order.id, order.released + (inOpen.get(order.id) ?? 0)])))
  const rows: QueueRow[] = []
  for (const order of bench) {
    const companyId = companies.get(order.id)
    if (!companyId || (query.companyId && companyId !== query.companyId)) continue
    const garments = garmentsToInspect({ finished: order.finished, released: order.released, inOpenInspections: inOpen.get(order.id) ?? 0 })
    if (garments <= 0) continue
    const record = { companyId, siteId: order.siteId }
    rows.push(
      rowOf(
        {
          key: `WorkOrder:${order.id}`,
          kind: 'FINAL_DUE',
          recordType: null,
          id: null,
          number: null,
          title: [order.number, order.style.code ? `${order.style.code} ${order.style.name}` : null].filter(Boolean).join(' · '),
          companyId,
          siteId: order.siteId,
          workOrder: { id: order.id, number: order.number },
          lot: null,
          item: order.style.code ? { code: order.style.code, name: order.style.name } : null,
          bundle: null,
          operation: null,
          plan: null,
          progress: { done: null, of: garments, words: { it: `${garments} ${garments === 1 ? 'capo finito' : 'capi finiti'} da collaudare`, en: `${garments} finished ${garments === 1 ? 'garment' : 'garments'} to inspect` } },
          openedAt: null,
          waitingSince: iso(since.get(order.id) ?? null),
          dueAt: null,
          blocks: blockOf({ kind: 'FINAL_DUE', workOrder: order.number, garments, dueDate: order.dueDate }, today),
          // Nobody's yet: whoever scans the work order at the bench opens it (and becomes its inspector).
          taken: 'NOBODY',
          may: { record: false, start: may(viewer, PERMISSIONS.final.record, record) },
          open: null,
          start: { code: order.number, stage: 'FINAL' },
          version: null,
        },
        now,
      ),
    )
  }
  return rows
}

// ---- incoming inspections -------------------------------------------------------------------------------------------------------------

const incomingRows = (caller: CommandCaller, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> => caller.withClient((db) => incomingRowsIn(db, viewer, query, now, today))

async function incomingRowsIn(db: FactoryClient, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> {
  const rows = await db.incomingInspection.findMany({
    where: { AND: [scopeOf(viewer, PERMISSIONS.incoming.view, query), { status: 'OPEN' }] },
    select: {
      id: true,
      number: true,
      companyId: true,
      siteId: true,
      lotId: true,
      itemId: true,
      workOrderId: true,
      subcontractReceiptId: true,
      planVersionId: true,
      lotSize: true,
      uom: true,
      sampleSize: true,
      inspectorWorkerId: true,
      inspectorUserId: true,
      dueAt: true,
      createdAt: true,
      version: true,
      lot: { select: { id: true, code: true, qualityStatus: true, itemColourId: true, item: { select: { code: true, name: true } } } },
      planVersion: { select: { number: true, plan: { select: { code: true } } } },
      _count: { select: { hideResults: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PER_KIND,
  })
  if (rows.length === 0) return []
  // Work that waits for a lot: open work orders of the lot's site that plan its item (and its colour, when both name one).
  const quarantined = rows.filter((row) => row.lot?.qualityStatus === 'QUARANTINE')
  const needs = quarantined.length
    ? await db.workOrderMaterial.findMany({
        where: { itemId: { in: [...new Set(quarantined.map((row) => row.itemId!))] }, siteId: { in: [...new Set(quarantined.map((row) => row.siteId))] }, workOrder: { status: { in: [...OPEN_WORK] } } },
        select: { itemId: true, itemColourId: true, siteId: true, workOrderId: true, workOrder: { select: { dueDate: true } } },
      })
    : []
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: rows.map((row) => row.workOrderId).filter((value): value is string => value !== null) } }, select: { id: true, number: true } })).map((order) => [order.id, order]))
  return rows.map((row) => {
    const lot = row.lot
    const wanted = lot ? needs.filter((need) => need.itemId === row.itemId && need.siteId === row.siteId && (need.itemColourId === null || lot.itemColourId === null || need.itemColourId === lot.itemColourId)) : []
    const orders = new Map(wanted.map((need) => [need.workOrderId, dayOf(need.workOrder.dueDate)]))
    const earliest = [...orders.values()].filter((value): value is string => value !== null).sort()[0] ?? null
    const lotSize = fixed(row.lotSize)
    const byHide = row.uom === 'HIDE'
    const taken = takenOf({ workerId: row.inspectorWorkerId, userId: row.inspectorUserId }, viewer.person)
    const workOrder = row.workOrderId ? workOrders.get(row.workOrderId) : undefined
    return rowOf(
      {
        key: `IncomingInspection:${row.id}`,
        kind: 'INCOMING',
        recordType: 'IncomingInspection',
        id: row.id,
        number: row.number,
        title: lot ? `${lot.code} · ${lot.item.name}` : `Workshop receipt · ${workOrder?.number ?? '—'}`,
        companyId: row.companyId,
        siteId: row.siteId,
        workOrder: workOrder ? { id: workOrder.id, number: workOrder.number } : null,
        lot: lot ? { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus } : null,
        item: lot ? { code: lot.item.code, name: lot.item.name } : null,
        bundle: null,
        operation: null,
        plan: row.planVersion ? { code: row.planVersion.plan.code, number: row.planVersion.number } : null,
        progress: { done: byHide ? row._count.hideResults : null, of: row.sampleSize, words: sampleWords(row.sampleSize, lotSize, row.uom, byHide ? row._count.hideResults : null) },
        openedAt: iso(row.createdAt),
        waitingSince: iso(row.createdAt),
        dueAt: iso(row.dueAt),
        blocks: lot
          ? blockOf({ kind: 'INCOMING', lot: lot.code, lotStatus: lot.qualityStatus, units: `${lotSize} ${row.uom.toLowerCase()}`, neededBy: { workOrders: orders.size, earliest } }, today)
          : blockOf({ kind: 'INCOMING', lot: null, lotStatus: null, units: `${lotSize} ${row.uom.toLowerCase()}`, neededBy: { workOrders: 0, earliest: null } }, today),
        taken,
        // A workshop's receipt is not recorded through B-W2b-98's routes yet (B-W2b-111): shown, not recordable here.
        may: { record: lot !== null && taken !== 'OTHER' && may(viewer, PERMISSIONS.incoming.record, row), start: false },
        open: lot ? { method: 'GET', path: `/quality/incoming/${row.id}` } : null,
        start: null,
        version: row.version,
      },
      now,
    )
  })
}

// ---- in-process checks ------------------------------------------------------------------------------------------------------------------

const checkRows = (caller: CommandCaller, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> => caller.withClient((db) => checkRowsIn(db, viewer, query, now, today))

async function checkRowsIn(db: FactoryClient, viewer: Viewer, query: QueueQuery, now: Date, today: string): Promise<QueueRow[]> {
  const rows = await db.inProcessCheck.findMany({
    where: { AND: [scopeOf(viewer, PERMISSIONS.inprocess.view, query), { status: 'OPEN' }] },
    select: { id: true, kind: true, companyId: true, siteId: true, lineId: true, workOrderId: true, bundleId: true, workOrderOperationId: true, planVersionId: true, inspectorWorkerId: true, inspectorUserId: true, createdAt: true, version: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PER_KIND,
  })
  if (rows.length === 0) return []
  const ids = (pick: (row: (typeof rows)[number]) => string | null) => [...new Set(rows.map(pick).filter((value): value is string => value !== null))]
  const [orders, bundles, operations, lines, versions] = await Promise.all([
    db.workOrder.findMany({ where: { id: { in: ids((row) => row.workOrderId) } }, select: { id: true, number: true, style: { select: { code: true, name: true } } } }),
    db.bundle.findMany({ where: { id: { in: ids((row) => row.bundleId) } }, select: { id: true, code: true } }),
    db.workOrderOperation.findMany({ where: { id: { in: ids((row) => row.workOrderOperationId) } }, select: { id: true, seq: true, code: true, name: true } }),
    db.line.findMany({ where: { id: { in: ids((row) => row.lineId) } }, select: { id: true, code: true } }),
    db.inspectionPlanVersion.findMany({ where: { id: { in: ids((row) => row.planVersionId) } }, select: { id: true, number: true, plan: { select: { code: true } } } }),
  ])
  const by = <Row extends { id: string }>(list: readonly Row[]) => new Map(list.map((row) => [row.id, row]))
  const [orderOf, bundleOf, operationOf, lineOf, versionOf] = [by(orders), by(bundles), by(operations), by(lines), by(versions)]
  return rows.map((row) => {
    const kind = row.kind as Extract<QueueKind, 'FIRST_PIECE' | 'CUTTING' | 'ROVING' | 'END_OF_LINE'>
    const order = row.workOrderId ? orderOf.get(row.workOrderId) : undefined
    const bundle = row.bundleId ? bundleOf.get(row.bundleId) : undefined
    const operation = row.workOrderOperationId ? operationOf.get(row.workOrderOperationId) : undefined
    const line = row.lineId ? lineOf.get(row.lineId) : undefined
    const version = row.planVersionId ? versionOf.get(row.planVersionId) : undefined
    const at = operation ? `${operation.seq} ${operation.name}` : null
    const taken = takenOf({ workerId: row.inspectorWorkerId, userId: row.inspectorUserId }, viewer.person)
    return rowOf(
      {
        key: `InProcessCheck:${row.id}`,
        kind,
        recordType: 'InProcessCheck',
        id: row.id,
        number: null,
        title: [bundle?.code ?? order?.number ?? line?.code ?? '—', at].filter(Boolean).join(' · '),
        companyId: row.companyId,
        siteId: row.siteId,
        workOrder: order ? { id: order.id, number: order.number } : null,
        lot: null,
        item: order ? { code: order.style.code, name: order.style.name } : null,
        bundle: bundle ? { id: bundle.id, code: bundle.code } : null,
        operation: operation ? { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name } : null,
        plan: version ? { code: version.plan.code, number: version.number } : null,
        progress: null,
        openedAt: iso(row.createdAt),
        waitingSince: iso(row.createdAt),
        dueAt: null,
        blocks: kind === 'FIRST_PIECE' ? blockOf({ kind, workOrder: order?.number ?? '—', operation: at, open: true }, today) : blockOf({ kind }, today),
        taken,
        // B-W2b-99 records a check's results for anyone with the right (a rule's check is nobody's; the floor takes it there).
        may: { record: row.planVersionId !== null && may(viewer, PERMISSIONS.inprocess.record, row), start: false },
        open: { method: 'GET', path: `/quality/inprocess/checks/${row.id}` },
        start: null,
        version: row.version,
      },
      now,
    )
  })
}

// ---- the queue --------------------------------------------------------------------------------------------------------------------------

/** Every row of the viewer's queue, sorted (scope and kind applied), before the limit. */
export async function queueRows(caller: CommandCaller, query: QueueQuery): Promise<{ viewer: Viewer; rows: QueueRow[]; now: Date }> {
  const viewer = viewerOf(caller)
  const now = new Date()
  const today = businessDate(now)
  const wants = (kinds: readonly QueueKind[]) => !query.kind || kinds.includes(query.kind)
  const rows = [
    ...(viewer.views.final && wants(['FINAL']) ? await finalRows(caller, viewer, query, now, today) : []),
    ...(viewer.views.final && wants(['FINAL_DUE']) ? await dueRows(caller, viewer, query, now, today) : []),
    ...(viewer.views.incoming && wants(['INCOMING']) ? await incomingRows(caller, viewer, query, now, today) : []),
    ...(viewer.views.inprocess && wants(['FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE']) ? await checkRows(caller, viewer, query, now, today) : []),
  ]
  const kept = rows.filter((row) => (!query.kind || row.kind === query.kind) && (query.scope === 'all' || isMine(row.taken)))
  const sorted = queueOrder(kept.map((row) => ({ key: row.key, block: row.blocks, dueAt: row.dueAt, waitingSince: row.waitingSince, row }))).map((entry) => entry.row)
  return { viewer, rows: sorted, now }
}

/** GET /quality/queue */
export async function readQueue(caller: CommandCaller, query: QueueQuery) {
  const { rows, now } = await queueRows(caller, query)
  return { asOf: toUtcIso(now), scope: query.scope, rows: rows.slice(0, query.limit), capped: rows.length > query.limit }
}
