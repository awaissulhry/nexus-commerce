import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DefectLine } from '@nexus/factory-domain/production/scans/rules'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'
import { readRequestDefects, writeDefects } from './defects-store'
import type { Reader } from './store'

/**
 * THE seam of the floor's correction requests (B-W1-42; MES-096; design floor.operation "Ask a correction": the original
 * stays, on approval a CORRECTION row voids it; W1 decisions in the Office, Home › Approvals): the ScanCorrectionRequest
 * rows with their lines (OperationScanDefect). The floor inserts its own asks (and reads its site's); the office decides,
 * after `lockCorrectionRequest` (the row FOR UPDATE), with a compare-and-set on the version. One PENDING ask per scan is
 * the ask command's check, read inside its transaction under the bundle's scan lock (so two asks of one scan take turns);
 * the …_production_scan_records_guards trigger holds the rest (asked PENDING of a standing scan, the subject rule, decided
 * once, four eyes).
 */

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REFUSED'] as const
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number]

export interface CorrectionRequest {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly workOrderId: string
  readonly bundleId: string
  readonly workOrderOperationId: string
  /** The standing scan (REPORT or CORRECTION) it asks to correct. */
  readonly scanId: string
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  readonly defects: readonly DefectLine[]
  readonly reason: string
  readonly status: CorrectionStatus
  /** The worker who asked (a site that names workers); null at a site that records the station only. */
  readonly askedById: string | null
  readonly stationId: string | null
  readonly deviceId: string | null
  /** The device's id for the ask (its queue's client scan id), unique per device. */
  readonly clientRequestId: string
  readonly deviceTime: string | null
  readonly serverTime: string
  readonly decidedById: string | null
  readonly decidedAt: string | null
  readonly decisionNote: string | null
  /** APPROVED: the CORRECTION scan it wrote. */
  readonly correctionScanId: string | null
  readonly version: number
}

const COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  bundleId: true,
  workOrderOperationId: true,
  scanId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  reason: true,
  status: true,
  askedById: true,
  stationId: true,
  deviceId: true,
  clientRequestId: true,
  deviceTime: true,
  serverTime: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  correctionScanId: true,
  version: true,
} as const satisfies Prisma.ScanCorrectionRequestSelect

type Row = Prisma.ScanCorrectionRequestGetPayload<{ select: typeof COLUMNS }>

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

function requestOf(row: Row, companyId: string, defects: readonly DefectLine[]): CorrectionRequest {
  const { deviceTime, serverTime, decidedAt, ...rest } = row
  return { ...rest, companyId, defects: [...defects], deviceTime: at(deviceTime), serverTime: toUtcIso(serverTime), decidedAt: at(decidedAt) }
}

/** The rows with their lines and their work order's company (read one after another: no relation select). */
async function withLines(db: Reader, rows: readonly Row[]): Promise<CorrectionRequest[]> {
  if (rows.length === 0) return []
  const lines = await readRequestDefects(db, rows.map((row) => row.id))
  const companies = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId))] } }, select: { id: true, companyId: true } })).map((row) => [row.id, row.companyId]))
  return rows.map((row) => requestOf(row, companies.get(row.workOrderId) ?? '', lines.get(row.id) ?? []))
}

const audited = (tools: CommandTools, action: string, request: CorrectionRequest, before?: Partial<CorrectionRequest>) =>
  tools.audit({ action, recordType: 'ScanCorrectionRequest', recordId: request.id, companyId: request.companyId, siteId: request.siteId, ...(before ? { before } : {}), after: request, ...(request.decisionNote ? { reason: request.decisionNote } : {}) })

/** Records a new PENDING request and its lines inside the floor's ask command. */
export async function insertCorrectionRequest(tools: CommandTools, request: CorrectionRequest): Promise<void> {
  const createdById = request.askedById
  await tools.tx.scanCorrectionRequest.create({
    data: {
      id: request.id,
      siteId: request.siteId,
      workOrderId: request.workOrderId,
      bundleId: request.bundleId,
      workOrderOperationId: request.workOrderOperationId,
      scanId: request.scanId,
      goodQuantity: request.goodQuantity,
      scrapQuantity: request.scrapQuantity,
      reworkQuantity: request.reworkQuantity,
      reason: request.reason,
      askedById: request.askedById,
      stationId: request.stationId,
      deviceId: request.deviceId,
      clientRequestId: request.clientRequestId,
      deviceTime: request.deviceTime ? new Date(request.deviceTime) : null,
      serverTime: tools.now,
      createdById,
      createdAt: tools.now,
      updatedAt: tools.now,
    },
    select: { id: true },
  })
  await writeDefects(tools, { correctionRequestId: request.id, siteId: request.siteId, createdById }, request.defects)
  audited(tools, 'production.askScanCorrection', request)
}

/** Records the decision inside the office's command (after lockCorrectionRequest): compare-and-set on the version. */
export async function decideCorrectionRequest(tools: CommandTools, before: CorrectionRequest, after: CorrectionRequest): Promise<void> {
  const { count } = await tools.tx.scanCorrectionRequest.updateMany({
    where: { id: before.id, version: before.version, status: 'PENDING' },
    data: {
      status: after.status,
      decidedById: after.decidedById,
      decidedAt: tools.now,
      decisionNote: after.decisionNote,
      correctionScanId: after.correctionScanId,
      version: before.version + 1,
      updatedAt: tools.now,
    },
  })
  if (count !== 1) throw new StaleVersionError('ScanCorrectionRequest', before.id, before.version + 1, before.version)
  audited(tools, after.status === 'APPROVED' ? 'production.approveScanCorrection' : 'production.refuseScanCorrection', after, { status: before.status, version: before.version })
}

export interface CorrectionFilter {
  /** Only these sites (absent: every site the reader sees). */
  readonly siteIds?: readonly string[]
  readonly status?: CorrectionStatus
  readonly workOrderId?: string
  readonly scanIds?: readonly string[]
  readonly deviceId?: string
  readonly clientRequestId?: string
  readonly askedById?: string
  /** The asks of a station at a site that records the station only (no asker named). */
  readonly stationId?: string
  readonly since?: Date
}

/** The requests that match, oldest ask first, in the caller's scope. */
export async function readCorrectionRequests(db: Reader, filter: CorrectionFilter = {}): Promise<CorrectionRequest[]> {
  const rows = await db.scanCorrectionRequest.findMany({
    where: {
      ...(filter.siteIds ? { siteId: { in: [...filter.siteIds] } } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.workOrderId ? { workOrderId: filter.workOrderId } : {}),
      ...(filter.scanIds ? { scanId: { in: [...filter.scanIds] } } : {}),
      ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter.clientRequestId ? { clientRequestId: filter.clientRequestId } : {}),
      ...(filter.askedById ? { askedById: filter.askedById } : {}),
      ...(filter.stationId ? { stationId: filter.stationId, askedById: null } : {}),
      ...(filter.since ? { serverTime: { gte: filter.since } } : {}),
    },
    select: COLUMNS,
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
  return withLines(db, rows)
}

/** One request, or null, in the caller's scope. */
export async function readCorrectionRequest(db: Reader, requestId: string): Promise<CorrectionRequest | null> {
  if (!isUuid(requestId)) return null
  const row = await db.scanCorrectionRequest.findUnique({ where: { id: requestId }, select: COLUMNS })
  return row ? ((await withLines(db, [row]))[0] ?? null) : null
}

/** The request's row locked for its decision (one decision at a time), then read. The office's transaction. */
export async function lockCorrectionRequest(tx: CommandTx, _tenantId: string, requestId: string): Promise<CorrectionRequest | null> {
  if (!isUuid(requestId)) return null
  await tx.$queryRaw`SELECT "id" FROM "ScanCorrectionRequest" WHERE "id" = ${requestId}::uuid FOR UPDATE`
  return readCorrectionRequest(tx, requestId)
}
