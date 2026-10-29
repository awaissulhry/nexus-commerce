import { isUuid } from '@nexus/factory-domain/core/ids'
import type { DefectLine } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { Reader } from './store'

/**
 * THE seam of the floor's correction requests (B-W1-42; MES-096; design floor.operation "Ask a correction": the original
 * stays, on approval a CORRECTION row voids it; W1 decisions in the Office, Home › Approvals): a request names one
 * standing scan and the counts it should have, why, who asked on which device; PENDING → APPROVED (with the CORRECTION
 * scan) | REFUSED, decided by a person who neither took the scan nor asked.
 *
 * INTERIM (until the schema step, the lead's SCHEMA token): a request is the newest of its audit rows (recordType
 * ScanCorrectionRequest, the whole request in `after`; the ask, then the decision), written inside the floor's and the
 * office's commands. Audit rows are office reading, so the reads take an office or system reader (a floor route reads
 * through the tenant's system view). One pending request per scan is the commands' check (a race of two asks of one scan
 * at the same moment is the table's partial unique index's to stop). Then: the ScanCorrectionRequest table (the floor
 * inserts its own, the office decides with a version guard). The signatures stay.
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

const RECORD = 'ScanCorrectionRequest'

const audited = (tools: CommandTools, action: string, request: CorrectionRequest, before?: Partial<CorrectionRequest>) =>
  tools.audit({ action, recordType: RECORD, recordId: request.id, companyId: request.companyId, siteId: request.siteId, ...(before ? { before } : {}), after: request, ...(request.decisionNote ? { reason: request.decisionNote } : {}) })

/** Records a new PENDING request inside the floor's ask command. */
export function insertCorrectionRequest(tools: CommandTools, request: CorrectionRequest): void {
  audited(tools, 'production.askScanCorrection', request)
}

/** Records the decision inside the office's command (after lockCorrectionRequest). */
export function decideCorrectionRequest(tools: CommandTools, before: CorrectionRequest, after: CorrectionRequest): void {
  audited(tools, after.status === 'APPROVED' ? 'production.approveScanCorrection' : 'production.refuseScanCorrection', after, { status: before.status, version: before.version })
}

function newest(rows: readonly { readonly recordId: string; readonly after: unknown }[]): CorrectionRequest[] {
  const byId = new Map<string, CorrectionRequest>()
  for (const row of rows) byId.set(row.recordId, row.after as CorrectionRequest)
  return [...byId.values()]
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
  readonly stationId?: string
  readonly since?: Date
}

/** The requests that match, oldest ask first. An office or system reader. */
export async function readCorrectionRequests(db: Reader, filter: CorrectionFilter = {}): Promise<CorrectionRequest[]> {
  const rows = await db.auditLog.findMany({
    where: { recordType: RECORD, ...(filter.siteIds ? { siteId: { in: [...filter.siteIds] } } : {}) },
    select: { recordId: true, after: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
  return newest(rows).filter(
    (request) =>
      (filter.status === undefined || request.status === filter.status) &&
      (filter.workOrderId === undefined || request.workOrderId === filter.workOrderId) &&
      (filter.scanIds === undefined || filter.scanIds.includes(request.scanId)) &&
      (filter.deviceId === undefined || request.deviceId === filter.deviceId) &&
      (filter.clientRequestId === undefined || request.clientRequestId === filter.clientRequestId) &&
      (filter.askedById === undefined || request.askedById === filter.askedById) &&
      (filter.stationId === undefined || (request.askedById === null && request.stationId === filter.stationId)) &&
      (filter.since === undefined || new Date(request.serverTime) >= filter.since),
  )
}

/** One request, or null. An office or system reader. */
export async function readCorrectionRequest(db: Reader, requestId: string): Promise<CorrectionRequest | null> {
  if (!isUuid(requestId)) return null
  const rows = await db.auditLog.findMany({ where: { recordType: RECORD, recordId: requestId }, select: { recordId: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  return newest(rows)[0] ?? null
}

/** The request locked for its decision (one decision at a time), then read. The office's transaction. */
export async function lockCorrectionRequest(tx: CommandTx, tenantId: string, requestId: string): Promise<CorrectionRequest | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-correction', ${tenantId}::uuid, ${requestId}::uuid), 0))`
  return readCorrectionRequest(tx, requestId)
}
