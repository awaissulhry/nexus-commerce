import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { shares, type ProductionShareLevel } from '@nexus/factory-domain/production-brand/levels'
import { PAUSED_WORDS, type BrandHoldRead } from '@nexus/factory-domain/production-brand/portal-read'
import {
  BRAND_CHECK_KINDS,
  cellFiguresOf,
  CHECK_KIND_WORDS,
  checkCountWords,
  checkSummariesOf,
  DEFECT_CLASS_WORDS,
  DEFECT_CLASSES,
  defectTotalsOf,
  FINAL_STATE_WORDS,
  finalStateOf,
  HOLD_STATE_WORDS,
  NO_REPORT_YET,
  QUALITY_NOT_SHARED,
  REPORT_NOT_FOUND,
  reportVersionOf,
  SHARED_WORK_WORDS,
  workOrderAlone,
  type BrandDefectClass,
  type CellCount,
} from '@nexus/factory-domain/production-brand/quality-read'
import { LEVEL_WORDS } from '@nexus/factory-domain/production-brand/words'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { listFiles, MissingFileError, readStoredFile, systemCallerOf } from '../../../platform/files/files'
import { contentWalledFor } from '../../../platform/files/content-wall' // fix-pr-2
import { processFiles } from '../../../platform/files/service'
import { reasonWords } from '../../../platform/reasons/service'
import { partnerOrder, portalReader, type PortalReader } from '../../sales/portal-orders/access'
import { namesOf, readLines, type PortalLine } from '../../sales/portal-orders/store'
import { GOODS_LINE_KINDS, isKeptState } from '../brand/facts'
import { PRODUCTION_HOLD_WORDS, QUALITY_HOLD_WORDS, readProductionRows, readProductionSettings, type ProductionSettings } from './access'
import { NOT_IN_PRODUCTION } from './read'

/**
 * B-PR-19 (production plan §2 the brand wall, §4 "+ Quality & photos — single-brand work orders only", 06-tree §0.5 and
 * P-ORD-quality, 08-backend "GET /portal/production/:orderId/quality"; lead pick L8; walls WALL-G02, WALL-G07; wall test PW-P04;
 * the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well."): the quality of the customer's own goods, at the QUALITY level
 * only (below it the section is not drawn: 404, as the progress read answers when it is not shared).
 *
 *   GET /portal/production/:orderId/quality
 *       per line and size of its own order: the pieces released by quality and taken back (every work order: a legacy one that
 *       mixed customers gives it only its own cells, never above what it ordered); final inspections (passed, failed, waiting,
 *       the sampling plan, the defects found, whether a report is issued) and first-piece, cutting and end-of-line checks ONLY
 *       of a work order that is its alone (WorkOrder.partyId = it and every cell of the work order its own; production-brand
 *       quality-read workOrderAlone) — a line made on a shared one reads "results are shared only for work made for you alone";
 *       what held its goods (quality holds on its work orders, its bundles or its serials; our production holds; its own pause)
 *       by reason code and words, never the office's note, never who; the photos the factory shared on its order (Use on,
 *       B-TH-024: visibility PARTNER, its party) whose source is its own record or one of no customer
 *   GET /portal/production/:orderId/quality/report/:inspectionId
 *       the inspection report PDF of a decided final inspection of a work order that is its alone and makes this order's
 *       goods: the factory's newest KEPT version (B-W2b-123; the same document a shipment's documents link carries), in its
 *       language when one is kept, else the newest. Any other inspection: 404 as an unknown one (a shared lot, another order,
 *       another customer, a wrong id); none kept yet: 404 in its own words
 *
 * The partner read comes first (its own order and lines, the photos shared with it); the office's facts are read only for that
 * order's own cells, in the tenant's scope as the person (./access.ts pattern). No answer names a work order, a lot of another's
 * goods, an inspector, a releaser, a worker, a line, a station, an office person or a note (FORBIDDEN_BRAND_KEYS).
 */

const LIVE = { events: ['brand_production.stage_reached', 'brand_production.hold_changed'] }

interface QualityOrder {
  readonly reader: PortalReader
  readonly partyId: string
  readonly order: Awaited<ReturnType<typeof partnerOrder>>
  readonly lines: readonly PortalLine[]
  readonly settings: ProductionSettings
}

/** Its own order (another customer's is as unknown as a wrong id), kept in production or with its row, at the QUALITY level. */
async function qualityOrder(app: FastifyInstance, request: FastifyRequest, orderId: string): Promise<QualityOrder> {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const own = await request.withClient(async (client) => ({ row: (await readProductionRows(client, [order.id])).get(order.id), lines: await readLines(client, [order.id]) }))
  // A shipped order keeps its state as history (its row); one that never was in production is not found here.
  if (!isKeptState(order.status) && !own.row) throw new NotFoundError(NOT_IN_PRODUCTION)
  const partyId = reader.session.partyId
  const settings = await reader.inTenant((client) => readProductionSettings(client, partyId))
  if (!shares(settings.level, 'quality')) throw new NotFoundError(QUALITY_NOT_SHARED)
  return { reader, partyId, order, lines: own.lines, settings }
}

// ---- the office's facts of its own cells (tenant scope, after the partner read) ----------------------------------------------

interface OwnCell {
  readonly id: string
  readonly workOrderId: string
  readonly lineId: string
  readonly size: string
}

interface OwnWork {
  /** The work order cells of its goods lines (not a repair, not a cancelled work order). */
  readonly cells: readonly OwnCell[]
  readonly workOrderIds: readonly string[]
  /** The work orders that are the customer's alone: only their results reach it. */
  readonly alone: ReadonlySet<string>
  /** The work orders whose customer is it (WorkOrder.partyId): the words of our production hold meant for it. */
  readonly own: ReadonlySet<string>
}

const NO_WORK: OwnWork = Object.freeze({ cells: [], workOrderIds: [], alone: new Set<string>(), own: new Set<string>() })

async function readOwnWork(db: FactoryClient, level: ProductionShareLevel, partyId: string, lines: readonly PortalLine[]): Promise<OwnWork> {
  const goods = lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind))
  if (goods.length === 0) return NO_WORK
  const rows = await db.workOrderSize.findMany({
    where: { salesOrderLineId: { in: goods.map((line) => line.id) }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } },
    select: { id: true, workOrderId: true, salesOrderLineId: true, size: true },
  })
  const cells = rows.flatMap((row) => (row.salesOrderLineId ? [{ id: row.id, workOrderId: row.workOrderId, lineId: row.salesOrderLineId, size: row.size }] : []))
  const workOrderIds = [...new Set(cells.map((cell) => cell.workOrderId))]
  if (workOrderIds.length === 0) return { ...NO_WORK, cells }
  const workOrders = await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, partyId: true } })
  // Every cell of those work orders (another customer's too): a work order is its alone only when no cell names another customer.
  const everyCell = await db.workOrderSize.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { workOrderId: true, partyId: true } })
  const alone = new Set(
    workOrders.filter((workOrder) => workOrderAlone(level, { partyId: workOrder.partyId, cellParties: everyCell.filter((cell) => cell.workOrderId === workOrder.id).map((cell) => cell.partyId) }, partyId)).map((workOrder) => workOrder.id),
  )
  return { cells, workOrderIds, alone, own: new Set(workOrders.filter((workOrder) => workOrder.partyId === partyId).map((workOrder) => workOrder.id)) }
}

/** Released and reversed pieces of each of its cells. */
async function readCellCounts(db: FactoryClient, cells: readonly OwnCell[]): Promise<CellCount[]> {
  const cellIds = cells.map((cell) => cell.id)
  if (cellIds.length === 0) return []
  const released = await db.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } })
  const reversed = await db.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } })
  const releasedOf = new Map(released.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const reversedOf = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  return cells.map((cell) => ({ lineId: cell.lineId, size: cell.size, released: releasedOf.get(cell.id) ?? 0, reversed: reversedOf.get(cell.id) ?? 0 }))
}

/** The final inspections of its single-customer work orders (a cancelled one never), with their defects and issued reports. */
async function readFinals(db: FactoryClient, work: OwnWork, lines: readonly PortalLine[], locale: string) {
  const alone = [...work.alone]
  if (alone.length === 0) return []
  const inspections = await db.inspection.findMany({
    where: { workOrderId: { in: alone }, status: { in: ['OPEN', 'PASSED', 'FAILED'] } },
    select: { id: true, workOrderId: true, number: true, status: true, lotSize: true, sampleSize: true, inspectionLevel: true, aqlMajor: true, aqlMinor: true, acceptMajor: true, acceptMinor: true, decidedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (inspections.length === 0) return []
  const decided = inspections.filter((inspection) => inspection.status !== 'OPEN').map((inspection) => inspection.id)
  const defects = decided.length > 0 ? await db.inspectionDefect.findMany({ where: { inspectionId: { in: decided } }, select: { inspectionId: true, defectClass: true, code: true, quantity: true, defectCodeId: true }, orderBy: [{ defectClass: 'asc' }, { code: 'asc' }] }) : []
  const codeIds = [...new Set(defects.flatMap((defect) => (defect.defectCodeId ? [defect.defectCodeId] : [])))]
  const labels = new Map<string, Words>(codeIds.length > 0 ? (await db.defectCode.findMany({ where: { id: { in: codeIds } }, select: { id: true, labelIt: true, labelEn: true } })).map((row): [string, Words] => [row.id, { it: row.labelIt, en: row.labelEn }]) : [])
  const versions = decided.length > 0 ? await db.generatedDocument.findMany({ where: { recordType: 'Inspection', recordId: { in: decided }, kind: 'INSPECTION_REPORT' }, select: { recordId: true, version: true, language: true, createdAt: true } }) : []
  // The order's lines each work order makes (by the line's number on the order).
  const seqOf = new Map(lines.map((line) => [line.id, line.seq]))
  const linesOf = new Map<string, Set<number>>()
  for (const cell of work.cells) {
    const seq = seqOf.get(cell.lineId)
    if (seq !== undefined) linesOf.set(cell.workOrderId, (linesOf.get(cell.workOrderId) ?? new Set<number>()).add(seq))
  }
  return inspections.flatMap((inspection) => {
    const state = finalStateOf(inspection.status)
    if (state === null) return []
    const own = defects.filter((defect) => defect.inspectionId === inspection.id)
    const totals = defectTotalsOf(own)
    const report = state === 'WAITING' ? null : reportVersionOf(versions.filter((version) => version.recordId === inspection.id), locale)
    return [
      {
        inspectionId: inspection.id,
        number: inspection.number,
        state,
        stateWords: FINAL_STATE_WORDS[state],
        decidedOn: inspection.decidedAt ? businessDate(inspection.decidedAt) : null,
        lines: [...(linesOf.get(inspection.workOrderId) ?? [])].sort((a, b) => a - b),
        // Its own goods alone: the lot and the sample are of nothing but its garments.
        sampling: {
          garments: inspection.lotSize,
          sample: inspection.sampleSize,
          inspectionLevel: inspection.inspectionLevel,
          aqlMajor: inspection.aqlMajor.toString(),
          aqlMinor: inspection.aqlMinor.toString(),
          acceptMajor: inspection.acceptMajor,
          acceptMinor: inspection.acceptMinor,
        },
        // While it is being recorded its defects may still change: shown once it is decided.
        defects:
          state === 'WAITING'
            ? null
            : {
                critical: totals.CRITICAL,
                major: totals.MAJOR,
                minor: totals.MINOR,
                found: own
                  .filter((defect) => (DEFECT_CLASSES as readonly string[]).includes(defect.defectClass))
                  .map((defect) => ({
                    defectClass: defect.defectClass as BrandDefectClass,
                    classWords: DEFECT_CLASS_WORDS[defect.defectClass as BrandDefectClass],
                    code: defect.code,
                    words: defect.defectCodeId ? (labels.get(defect.defectCodeId) ?? null) : null,
                    garments: defect.quantity,
                  })),
              },
        report: report ? { version: report.version, language: report.language, madeOn: businessDate(report.createdAt) } : null,
      },
    ]
  })
}

/** First-piece, cutting and end-of-line checks of its single-customer work orders, summed per kind (never a roving check). */
async function readChecks(db: FactoryClient, work: OwnWork) {
  const alone = [...work.alone]
  if (alone.length === 0) return []
  const rows = await db.inProcessCheck.findMany({
    where: { workOrderId: { in: alone }, kind: { in: [...BRAND_CHECK_KINDS] }, status: { in: ['OPEN', 'DECIDED'] } },
    select: { kind: true, status: true, outcome: true, pieces: true, defectivePieces: true, decidedAt: true },
  })
  return checkSummariesOf(rows.map((row) => ({ kind: row.kind, status: row.status, outcome: row.outcome, pieces: row.pieces, defectivePieces: row.defectivePieces, decidedOn: row.decidedAt ? businessDate(row.decidedAt) : null }))).map((summary) => ({
    kind: summary.kind,
    words: CHECK_KIND_WORDS[summary.kind],
    state: summary.state,
    stateWords: FINAL_STATE_WORDS[summary.state],
    passed: summary.passed,
    failed: summary.failed,
    waiting: summary.waiting,
    countWords: checkCountWords(summary),
    pieces: summary.pieces,
    defectivePieces: summary.defectivePieces,
    lastOn: summary.lastOn,
  }))
}

interface HoldRead {
  readonly kind: BrandHoldRead
  readonly code: string
  readonly words: Words
  readonly since: BusinessDate
  readonly until: BusinessDate | null
  readonly active: boolean
  readonly stateWords: Words
}

/**
 * What held its goods, active or ended: quality holds on its work orders (a legacy shared one too: its own goods were held),
 * its bundles or its serials, by the HOLD reason's words; our production holds by the words meant for it on its own work order,
 * else the PRODUCTION_HOLD reason's words; its own pause in its words. Never the note, never who placed or lifted it.
 */
async function readHolds(db: FactoryClient, work: OwnWork): Promise<HoldRead[]> {
  if (work.workOrderIds.length === 0) return []
  const cellIds = work.cells.map((cell) => cell.id)
  const bundles = cellIds.length > 0 ? (await db.bundle.findMany({ where: { workOrderSizeId: { in: cellIds } }, select: { id: true } })).map((row) => row.id) : []
  const serials = cellIds.length > 0 ? (await db.garmentSerial.findMany({ where: { workOrderSizeId: { in: cellIds } }, select: { id: true } })).map((row) => row.id) : []
  const quality = await db.qualityHold.findMany({
    where: {
      OR: [
        { subjectType: 'WorkOrder', subjectIds: { hasSome: [...work.workOrderIds] } },
        ...(bundles.length > 0 ? [{ subjectType: 'Bundle', subjectIds: { hasSome: bundles } }] : []),
        ...(serials.length > 0 ? [{ subjectType: 'GarmentSerial', subjectIds: { hasSome: serials } }] : []),
      ],
    },
    select: { id: true, reasonCode: true, status: true, placedAt: true, releasedAt: true, closedAt: true },
  })
  const plain = await db.workOrderHold.findMany({ where: { workOrderId: { in: [...work.workOrderIds] } }, select: { id: true, workOrderId: true, kind: true, reasonCode: true, brandWords: true, status: true, placedAt: true, liftedAt: true } })
  const holdWords = quality.length > 0 ? await reasonWords(db, 'HOLD') : new Map()
  const productionWords = plain.some((hold) => hold.kind === 'PRODUCTION') ? await reasonWords(db, 'PRODUCTION_HOLD') : new Map()
  const wordsOf = (fact: { labelIt: string; labelEn: string } | undefined, fallback: Words): Words => (fact ? { it: fact.labelIt, en: fact.labelEn } : fallback)
  const entry = (kind: BrandHoldRead, code: string, words: Words, placedAt: Date, endedAt: Date | null, active: boolean): HoldRead => ({
    kind,
    code,
    words,
    since: businessDate(placedAt),
    until: active || endedAt === null ? null : businessDate(endedAt),
    active,
    stateWords: HOLD_STATE_WORDS[active ? 'ACTIVE' : 'ENDED'],
  })
  const holds: HoldRead[] = [
    ...quality.map((hold) => entry('QUALITY', hold.reasonCode, wordsOf(holdWords.get(hold.reasonCode), QUALITY_HOLD_WORDS), hold.placedAt, hold.releasedAt ?? hold.closedAt, hold.status === 'ACTIVE')),
    ...plain.map((hold) => {
      if (hold.kind === 'BRAND') return entry('BRAND', hold.reasonCode, PAUSED_WORDS, hold.placedAt, hold.liftedAt, hold.status === 'ACTIVE')
      // The words meant for the customer only on its own work order (a legacy shared one reads the reason's words).
      const meant = work.own.has(hold.workOrderId) ? hold.brandWords?.trim() : undefined
      return entry('PRODUCTION', hold.reasonCode, meant ? { it: meant, en: meant } : wordsOf(productionWords.get(hold.reasonCode), PRODUCTION_HOLD_WORDS), hold.placedAt, hold.liftedAt, hold.status === 'ACTIVE')
    }),
  ]
  return holds.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : Number(b.active) - Number(a.active) || a.kind.localeCompare(b.kind)))
}

/**
 * The photos shared with it on its order (the partner read: files of the order shared with its party, row-level security first),
 * each drawn only when every record of its content is its own or of no customer: fix-pr-2, the threads lane's one content rule
 * (platform/files/content-wall contentWalledFor — the photo's record, then its source's, a copy of a copy up to 8 hops, read in
 * the tenant's scope; a mixed work order names several customers; a source that cannot be read: not drawn, fail closed).
 */
async function readPhotos(request: FastifyRequest, reader: PortalReader, partyId: string, orderId: string) {
  const photos = (await listFiles(request, { recordType: 'SalesOrder', recordId: orderId })).filter((file) => file.kind === 'PHOTO')
  if (photos.length === 0) return []
  const walled = await reader.inTenant((db) => contentWalledFor(db, partyId, photos.map((photo) => photo.id)))
  return photos
    .filter((photo) => !walled.has(photo.id))
    .map((photo) => ({ id: photo.id, name: photo.originalName, contentType: photo.contentType, sizeBytes: photo.sizeBytes, sharedOn: businessDate(new Date(photo.createdAt)) }))
}

/** GET /portal/production/:orderId/quality (see the file's head). */
export async function productionQuality(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const { reader, partyId, order, lines, settings } = await qualityOrder(app, request, orderId)
  const locale = reader.session.person.locale === 'it' ? 'it' : 'en'
  const goods = lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind))
  const tenant = await reader.inTenant(async (db) => {
    const work = await readOwnWork(db, settings.level, partyId, goods)
    return {
      work,
      counts: await readCellCounts(db, work.cells),
      finals: await readFinals(db, work, goods, locale),
      checks: await readChecks(db, work),
      holds: await readHolds(db, work),
      names: await namesOf(db, [...new Set(goods.map((line) => line.styleId))], [...new Set(goods.map((line) => line.colourwayId))]),
    }
  })
  const photos = await readPhotos(request, reader, partyId, order.id)
  const figures = cellFiguresOf(
    goods.map((line) => ({ id: line.id, quantity: line.quantity, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })) })),
    tenant.counts,
  )
  return {
    asOf: toUtcIso(now),
    level: settings.level,
    levelWords: LEVEL_WORDS[settings.level],
    order: { id: order.id, customerRef: order.customerRef, number: order.number, yourNumber: customerNumberOf('ORDER', order.customerSeq) },
    lines: goods.map((line) => {
      const sizes = figures.get(line.id) ?? []
      const style = tenant.names.styles.get(line.styleId)
      const colourway = tenant.names.colourways.get(line.colourwayId)
      const sharedWork = tenant.work.cells.some((cell) => cell.lineId === line.id && !tenant.work.alone.has(cell.workOrderId))
      return {
        lineId: line.id,
        seq: line.seq,
        style: style ? { code: style.code, name: style.name } : null,
        colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
        ordered: sizes.reduce((sum, size) => sum + size.ordered, 0),
        released: sizes.reduce((sum, size) => sum + size.released, 0),
        reversed: sizes.reduce((sum, size) => sum + size.reversed, 0),
        sizes: sizes.map((size) => ({ ...size })),
        sharedWork,
        sharedWorkWords: sharedWork ? SHARED_WORK_WORDS : null,
      }
    }),
    finals: tenant.finals,
    checks: tenant.checks,
    holds: tenant.holds,
    photos,
    live: LIVE,
  }
}

/** GET /portal/production/:orderId/quality/report/:inspectionId (see the file's head): the PDF's bytes and its name. */
export async function productionQualityReport(app: FastifyInstance, request: FastifyRequest, orderId: string, inspectionId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const { reader, partyId, lines, settings } = await qualityOrder(app, request, orderId)
  const locale = reader.session.person.locale === 'it' ? 'it' : 'en'
  const found = await reader.inTenant(async (db) => {
    const work = await readOwnWork(db, settings.level, partyId, lines)
    const inspection = await db.inspection.findUnique({ where: { id: inspectionId }, select: { id: true, workOrderId: true, status: true } })
    // A decided inspection of a work order that is its alone and makes this order's goods; anything else is as unknown.
    if (!inspection || !work.alone.has(inspection.workOrderId) || (inspection.status !== 'PASSED' && inspection.status !== 'FAILED')) return null
    const versions = await db.generatedDocument.findMany({ where: { recordType: 'Inspection', recordId: inspection.id, kind: 'INSPECTION_REPORT' }, select: { version: true, language: true, fileId: true } })
    const chosen = reportVersionOf(versions, locale)
    if (!chosen) return { file: null }
    const file = await db.storedFile.findUnique({ where: { id: chosen.fileId }, select: { id: true, status: true, originalName: true, storeAccountId: true, storageKey: true, sizeBytes: true, sha256: true } })
    return { file: file && file.status === 'AVAILABLE' ? file : null }
  })
  if (!found) throw new NotFoundError(REPORT_NOT_FOUND)
  if (!found.file) throw new NotFoundError(NO_REPORT_YET)
  // The store is read as the tenant's system (a portal caller makes no gateway call of its own), the bytes checked as kept.
  const bytes = await readStoredFile(processFiles(), systemCallerOf(request)(reader.session.tenantId), found.file, found.file.sizeBytes)
  if (createHash('sha256').update(bytes).digest('hex') !== found.file.sha256) throw new MissingFileError()
  return { bytes, fileName: found.file.originalName }
}
