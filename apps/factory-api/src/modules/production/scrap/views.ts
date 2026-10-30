import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { ReworkStatus } from '@nexus/factory-domain/production/rework/rules'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { readCellLabels, scrapFactsOf, scrapMaterials, type Reader, type ScrapFacts, type ScrapMaterial } from './store'

/**
 * Scrap & rework, the office's read (B-W2a-13; MES-129, MES-130, MES-126; design production.scrap "Scrap tiles" and the
 * "Scrap and rework" grid): every scrapped garment with its reason, the operation and bundle, and the leather it held
 * per lot and hide (the area, and its value with the cost grain), and every rework order; each with its replacements.
 * Rows come from the scans' scrap lines (a standing REPORT or CORRECTION: an undone or corrected scan counts no more),
 * the scrap of finished rework, and the rework orders. Per work order, bundle, operation and station: never per person
 * (Statuto dei Lavoratori art. 4).
 */

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const SCOPE = { company: 'companyId', site: 'siteId' } as const
const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

export interface ScrapQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  /** From and to instants (serverTime of the scan, doneAt of the rework). */
  readonly from?: Date | undefined
  readonly to?: Date | undefined
  readonly kind?: 'SCRAP' | 'REWORK' | undefined
  readonly limit: number
}

interface Row {
  readonly id: string
  readonly kind: 'SCRAP' | 'REWORK'
  readonly source: { readonly type: 'SCAN' | 'REWORK'; readonly id: string }
  readonly at: Date
  readonly companyId: string
  readonly siteId: string
  readonly workOrderId: string
  readonly bundleId: string | null
  readonly operationId: string | null
  readonly cellId: string
  readonly pieces: number
  readonly reasonCode: string
  readonly stationId: string | null
  readonly status: ReworkStatus | null
}

/** GET /production/scrap: the newest rows first (at most `limit`), with the tiles of the same scope. */
export async function scrapList(caller: CommandCaller, query: ScrapQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const withCost = heldGrains(actor).has('cost')
  const scope = scopeWhere(actor, PRODUCTION_SCRAP_VIEW, SCOPE)
  const filters = [query.siteId ? { siteId: query.siteId } : {}, query.workOrderId ? { workOrderId: query.workOrderId } : {}]
  return caller.withClient(async (db) => {
    const rows: Row[] = []
    if (query.kind !== 'REWORK') {
      // The scans that scrapped, standing (no later row voids them), with their scrap lines.
      const scans = await db.operationScan.findMany({
        where: {
          AND: [
            // A scan has no company column: its work order's scope.
            { workOrder: { is: scope as Prisma.WorkOrderWhereInput } },
            ...filters,
            { kind: { in: ['REPORT', 'CORRECTION'] }, scrapQuantity: { gt: 0 } },
            query.from ? { serverTime: { gte: query.from } } : {},
            query.to ? { serverTime: { lt: query.to } } : {},
          ],
        },
        select: { id: true, siteId: true, workOrderId: true, bundleId: true, workOrderOperationId: true, stationId: true, serverTime: true },
        orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
        take: query.limit,
      })
      const voided = new Set((await db.operationScan.findMany({ where: { correctsId: { in: scans.map((scan) => scan.id) } }, select: { correctsId: true } })).map((row) => row.correctsId!))
      const standing = scans.filter((scan) => !voided.has(scan.id))
      const lines = await db.operationScanDefect.findMany({ where: { scanId: { in: standing.map((scan) => scan.id) }, kind: 'SCRAP' }, select: { scanId: true, reasonCode: true, quantity: true } })
      const companies = new Map((await db.workOrder.findMany({ where: { id: { in: unique(standing.map((scan) => scan.workOrderId)) } }, select: { id: true, companyId: true } })).map((row) => [row.id, row.companyId]))
      const cells = new Map((await db.bundle.findMany({ where: { id: { in: unique(standing.map((scan) => scan.bundleId)) } }, select: { id: true, workOrderSizeId: true } })).map((row) => [row.id, row.workOrderSizeId]))
      for (const scan of standing) {
        for (const line of lines.filter((row) => row.scanId === scan.id)) {
          rows.push({ id: `scan:${scan.id}:${line.reasonCode}`, kind: 'SCRAP', source: { type: 'SCAN', id: scan.id }, at: scan.serverTime, companyId: companies.get(scan.workOrderId) ?? '', siteId: scan.siteId, workOrderId: scan.workOrderId, bundleId: scan.bundleId, operationId: scan.workOrderOperationId, cellId: cells.get(scan.bundleId) ?? '', pieces: line.quantity, reasonCode: line.reasonCode, stationId: scan.stationId, status: null })
        }
      }
    }
    // Rework orders (kind REWORK), and the scrap of finished ones (kind SCRAP).
    const reworks = await db.reworkOrder.findMany({
      where: { AND: [scope as Prisma.ReworkOrderWhereInput, ...filters, query.from ? { createdAt: { gte: query.from } } : {}, query.to ? { createdAt: { lt: query.to } } : {}] },
      select: { id: true, companyId: true, siteId: true, workOrderId: true, workOrderSizeId: true, bundleId: true, foundAtOperationId: true, reworkAtOperationId: true, quantity: true, scrapQuantity: true, reasonCode: true, status: true, doneAt: true, createdAt: true },
      orderBy: { id: 'desc' },
      take: query.limit,
    })
    for (const rework of reworks) {
      const base = { companyId: rework.companyId, siteId: rework.siteId, workOrderId: rework.workOrderId, bundleId: rework.bundleId, cellId: rework.workOrderSizeId, reasonCode: rework.reasonCode, stationId: null }
      if (query.kind !== 'SCRAP') rows.push({ ...base, id: `rework:${rework.id}`, kind: 'REWORK', source: { type: 'REWORK', id: rework.id }, at: rework.createdAt, operationId: rework.foundAtOperationId ?? rework.reworkAtOperationId, pieces: rework.quantity, status: rework.status })
      if (query.kind !== 'REWORK' && rework.status === 'DONE' && rework.scrapQuantity > 0) {
        rows.push({ ...base, id: `rework-scrap:${rework.id}`, kind: 'SCRAP', source: { type: 'REWORK', id: rework.id }, at: rework.doneAt!, operationId: rework.reworkAtOperationId, pieces: rework.scrapQuantity, status: rework.status })
      }
    }
    rows.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
    const page = rows.slice(0, query.limit)
    return { rows: await rowViews(db, page, withCost), tiles: await tilesOf(db, scope, filters) }
  })
}

async function rowViews(db: Reader, rows: readonly Row[], withCost: boolean) {
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true } })).map((row) => [row.id, row]))
  const bundles = await db.bundle.findMany({ where: { id: { in: unique(rows.map((row) => row.bundleId)) } }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, part: true, cutLogIds: true } })
  const bundleOf = new Map(bundles.map((row) => [row.id, row]))
  const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: unique(rows.map((row) => row.operationId)) } }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]))
  const cells = await readCellLabels(db, unique(rows.map((row) => row.cellId)))
  const reasons = new Map((await db.scrapReason.findMany({ where: { code: { in: unique(rows.map((row) => row.reasonCode)) } }, select: { kind: true, code: true, labelIt: true, labelEn: true } })).map((row) => [`${row.kind}|${row.code}`, row]))
  const stations = new Map((await db.station.findMany({ where: { id: { in: unique(rows.map((row) => row.stationId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const replacements = await db.replacementRequest.findMany({
    where: { OR: [{ sourceScanId: { in: unique(rows.filter((row) => row.source.type === 'SCAN').map((row) => row.source.id)) } }, { reworkOrderId: { in: unique(rows.filter((row) => row.source.type === 'REWORK').map((row) => row.source.id)) } }] },
    select: { id: true, kind: true, status: true, quantity: true, sourceScanId: true, reworkOrderId: true },
  })
  // The leather each scrapped row held: the facts once per work order.
  const facts = new Map<string, ScrapFacts>()
  for (const workOrderId of unique(rows.filter((row) => row.kind === 'SCRAP' && row.bundleId).map((row) => row.workOrderId))) {
    facts.set(workOrderId, await scrapFactsOf(db, workOrderId, bundles.filter((bundle) => bundle.workOrderId === workOrderId)))
  }
  return rows.map((row) => {
    const bundle = row.bundleId ? bundleOf.get(row.bundleId) : undefined
    const operation = row.operationId ? operations.get(row.operationId) : undefined
    const cell = cells.get(row.cellId)
    const reason = reasons.get(`${row.kind === 'REWORK' ? 'REWORK' : row.source.type === 'REWORK' ? 'REWORK' : 'SCRAP'}|${row.reasonCode}`)
    const materials: ScrapMaterial[] = row.kind === 'SCRAP' && bundle && facts.has(row.workOrderId) ? scrapMaterials(facts.get(row.workOrderId)!, bundle, row.pieces) : []
    const value = materials.every((material) => material.value !== null) && materials.length > 0 ? materials.reduce((sum, material) => sum + material.value!, 0) : null
    return {
      id: row.id,
      kind: row.kind,
      source: row.source,
      at: toUtcIso(row.at),
      workOrder: { id: row.workOrderId, number: orders.get(row.workOrderId)?.number ?? '', status: orders.get(row.workOrderId)?.status ?? 'RELEASED' },
      bundle: bundle ? { id: bundle.id, code: bundle.code } : null,
      operation: operation ? { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name } : null,
      cell: { id: row.cellId, colourwayCode: cell?.colourwayCode ?? '', size: cell?.size ?? '' },
      part: bundle?.part ?? null,
      pieces: row.pieces,
      reasonCode: row.reasonCode,
      reasonLabel: reason ? { it: reason.labelIt, en: reason.labelEn } : null,
      status: row.status,
      station: row.stationId ? { id: row.stationId, code: stations.get(row.stationId) ?? '' } : null,
      materials: materials.map((material) => ({ lotId: material.lotId, lotCode: material.lotCode, hideId: material.hideId, hideCode: material.hideCode, itemId: material.itemId, uom: material.uom, area: material.area, ...(withCost ? { value: asMoney('cost', material.value) } : {}) })),
      replacements: replacements
        .filter((request) => (row.source.type === 'SCAN' ? request.sourceScanId === row.source.id : request.reworkOrderId === row.source.id))
        .map((request) => ({ id: request.id, kind: request.kind, status: request.status, quantity: request.quantity })),
      ...(withCost ? { value: asMoney('cost', value), currency: asMoney('cost', materials.find((material) => material.currency)?.currency ?? null) } : {}),
    }
  })
}

/** The tiles: scrap today (pieces, Europe/Rome day), rework open, recuts to cut, reductions to approve. */
async function tilesOf(db: Reader, scope: object, filters: readonly object[]) {
  const since = businessDayStart(businessDate(serverClock.now()))
  const scans = await db.operationScan.findMany({ where: { AND: [{ workOrder: { is: scope as Prisma.WorkOrderWhereInput } }, ...filters, { kind: { in: ['REPORT', 'CORRECTION'] }, scrapQuantity: { gt: 0 }, serverTime: { gte: since } }] }, select: { id: true, scrapQuantity: true } })
  const voided = new Set((await db.operationScan.findMany({ where: { correctsId: { in: scans.map((scan) => scan.id) } }, select: { correctsId: true } })).map((row) => row.correctsId!))
  const reworkScrap = await db.reworkOrder.aggregate({ where: { AND: [scope as Prisma.ReworkOrderWhereInput, ...filters, { status: 'DONE', doneAt: { gte: since } }] }, _sum: { scrapQuantity: true } })
  return {
    scrapToday: scans.filter((scan) => !voided.has(scan.id)).reduce((sum, scan) => sum + scan.scrapQuantity, 0) + (reworkScrap._sum.scrapQuantity ?? 0),
    reworkOpen: await db.reworkOrder.count({ where: { AND: [scope as Prisma.ReworkOrderWhereInput, ...filters, { status: { in: ['OPEN', 'IN_PROGRESS'] } }] } }),
    recutsToCut: await db.replacementRequest.count({ where: { AND: [scope as Prisma.ReplacementRequestWhereInput, ...filters, { kind: 'RECUT', status: 'OPEN' }] } }),
    reductionsToApprove: await db.replacementRequest.count({ where: { AND: [scope as Prisma.ReplacementRequestWhereInput, ...filters, { kind: 'REDUCE', status: 'OPEN' }] } }),
  }
}
