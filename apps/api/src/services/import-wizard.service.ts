/** Legacy ImportJob entry point. Catalog writes use the reviewed transfer service. */
import type { ImportJob, PrismaClient } from '@prisma/client'
import prisma from '../db.js'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import { stageTransferJob, applyTransferJob, retryTransferJob, TRANSFER_JOB_KIND } from './pim/catalog-transfer-jobs.js'
import { TransferConflict } from './pim/catalog-transfer.service.js'

export type FileKind = 'csv' | 'xlsx' | 'json'
export type TargetEntity = 'product' | 'channelListing' | 'inventory'
export type OnErrorMode = 'abort' | 'skip'
export interface ParsedRow { rowIndex: number; values: Record<string, unknown>; parseError?: string }
export interface CreateJobInput {
  jobName: string; description?: string | null; source: 'upload' | 'url' | 'ftp'; sourceUrl?: string | null
  filename?: string | null; fileKind: FileKind; targetEntity: TargetEntity; columnMapping: Record<string, string>
  onError?: OnErrorMode; rows: ParsedRow[]; scheduleId?: string | null; parentJobId?: string | null; createdBy?: string | null; market?: string
}
export interface ApplyResult { jobId: string; status: string; totalRows: number; successRows: number; failedRows: number; skippedRows: number }

export class ImportWizardService {
  constructor(private prisma: PrismaClient = prisma) {}
  async create(input: CreateJobInput): Promise<ImportJob> {
    if (input.targetEntity !== 'product') throw new TransferConflict('Use Catalog import to declare exact listing destinations; inventory belongs to stock adjustments')
    if (!/^[A-Z]{2}$/.test(input.market ?? '')) throw new TransferConflict('Choose a marketplace and source ownership policy in Catalog import before reviewing this legacy file')
    const rows: TransferRow[] = [], issues: { row: number; sku: string; field: string; message: string }[] = []
    for (const row of input.rows) {
      const sku = typeof row.values.sku === 'string' ? row.values.sku.trim() : ''
      if (!sku || row.parseError) { issues.push({ row: row.rowIndex, sku, field: 'sku', message: row.parseError ?? 'A stable SKU is required' }); continue }
      for (const [field, value] of Object.entries(row.values)) {
        if (field === 'sku' || value == null || value === '') continue
        rows.push({ row: row.rowIndex, sku, entity: 'Products', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field, action: 'SET', value })
      }
    }
    const staged = await stageTransferJob({ rows, issues, mode: 'update', market: input.market!, filename: input.filename ?? input.jobName, userId: input.createdBy ?? null, parentJobId: input.parentJobId ?? undefined })
    return this.prisma.importJob.findUniqueOrThrow({ where: { id: staged.jobId } })
  }
  async get(id: string, userId?: string | null) {
    return this.prisma.importJob.findFirst({ where: { id, ...(userId !== undefined ? { createdBy: userId } : {}) } })
  }
  async listRows(jobId: string, filter: { status?: string; limit?: number; offset?: number } = {}) {
    return this.prisma.importJobRow.findMany({ where: { jobId, ...(filter.status ? { status: filter.status } : {}) }, orderBy: { rowIndex: 'asc' }, take: Math.min(Math.max(filter.limit || 50, 1), 100), skip: Math.max(filter.offset || 0, 0) })
  }
  async list(filter: { status?: string; limit?: number; userId?: string | null } = {}) {
    return this.prisma.importJob.findMany({ where: { targetEntity: { in: ['product', 'channelListing', 'inventory', TRANSFER_JOB_KIND] }, ...(filter.status ? { status: filter.status } : {}), ...(filter.userId !== undefined ? { createdBy: filter.userId } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(filter.limit || 100, 1), 100) })
  }
  async apply(jobId: string, reviewToken?: string, userId?: string | null): Promise<ApplyResult> {
    const job = await this.get(jobId, userId)
    if (!job) throw new TransferConflict('Import job not found')
    if (job.targetEntity !== TRANSFER_JOB_KIND) throw new TransferConflict('This legacy preview has no record versions or ownership policy. Upload it in Catalog import for a new review.')
    const result = await applyTransferJob(job.id, job.createdBy, reviewToken!)
    if (!result) throw new TransferConflict('Import job not found')
    return { jobId, status: result.state, totalRows: result.total, successRows: job.successRows, failedRows: job.failedRows, skippedRows: job.skippedRows }
  }
  async retryFailed(id: string, userId?: string | null) {
    const job = await this.get(id, userId)
    if (!job || job.targetEntity !== TRANSFER_JOB_KIND) throw new TransferConflict('Upload the failed legacy rows in Catalog import for a fresh review')
    const next = await retryTransferJob(id, job.createdBy)
    if (!next) throw new TransferConflict('Import job not found')
    return this.prisma.importJob.findUniqueOrThrow({ where: { id: next.jobId } })
  }
  async rollback(_id: string): Promise<ApplyResult> {
    throw new TransferConflict('Unversioned rollback is unavailable. Export current catalog values and review explicit corrections in Catalog import.')
  }
}
