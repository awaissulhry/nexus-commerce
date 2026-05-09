/**
 * W8.1 — Import wizard service.
 *
 * Owns the full lifecycle of an ImportJob:
 *
 *   create()    — parse + validate the source file (or pulled
 *                 payload), seed an ImportJob row in
 *                 PENDING_PREVIEW with one ImportJobRow per source
 *                 row. Operator reviews + confirms via the W8.3 UI.
 *
 *   apply()     — walk the rows, write per the targetEntity (today:
 *                 product), flip each ImportJobRow's terminal status
 *                 + bump aggregate counters on the job. Honors the
 *                 onError mode: 'skip' (default) commits successful
 *                 rows even if some failed; 'abort' rolls everything
 *                 back on the first failure.
 *
 *   retryFailed() — fork the failed-rows-only into a new ImportJob
 *                 with parentJobId pointing at the original. Same
 *                 columnMapping + onError. Useful when a transient
 *                 failure (DB hiccup) clobbered a chunk and the
 *                 operator wants to re-run only those.
 *
 *   rollback()  — re-apply each SUCCESS row's beforeState back to
 *                 the entity. Per-row best-effort; the rollback
 *                 writes a child ImportJob with a new id linking
 *                 via parentJobId so the chain is auditable.
 *
 * The parser layer (W8.2) is separate so each file format has its
 * own pure module testable in isolation. This service owns the
 * DB-side bookkeeping + the entity-write fan-out.
 */

import type {
  ImportJob,
  ImportJobRow,
  PrismaClient,
} from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export type FileKind = 'csv' | 'xlsx' | 'json'
export type TargetEntity = 'product' | 'channelListing' | 'inventory'
export type OnErrorMode = 'abort' | 'skip'

export interface ParsedRow {
  /** 1-based, header-skipped row index in the original file. */
  rowIndex: number
  /** Resolved (already mapped from source columns to target fields)
   *  field-value bag. The W8.2 mapping resolver builds this. */
  values: Record<string, unknown>
  /** Pre-validation error caught at parse time (e.g. malformed
   *  number in a column the schema declares numeric). When set, the
   *  row goes straight to FAILED on apply with this as the reason. */
  parseError?: string
}

export interface CreateJobInput {
  jobName: string
  description?: string | null
  source: 'upload' | 'url' | 'ftp'
  sourceUrl?: string | null
  filename?: string | null
  fileKind: FileKind
  targetEntity: TargetEntity
  columnMapping: Record<string, string>
  onError?: OnErrorMode
  rows: ParsedRow[]
  scheduleId?: string | null
  parentJobId?: string | null
  createdBy?: string | null
}

export interface ApplyResult {
  jobId: string
  status: string
  totalRows: number
  successRows: number
  failedRows: number
  skippedRows: number
}

export class ImportWizardService {
  constructor(private prisma: PrismaClient = prisma) {}

  /**
   * Persist an import job + its parsed rows. The job lands in
   * PENDING_PREVIEW; the operator (or scheduled-import worker)
   * confirms via apply().
   */
  async create(input: CreateJobInput): Promise<ImportJob> {
    if (!input.jobName || !input.jobName.trim()) {
      throw new Error('jobName is required')
    }
    if (!['csv', 'xlsx', 'json'].includes(input.fileKind)) {
      throw new Error(`Unknown fileKind: ${input.fileKind}`)
    }
    if (!['product', 'channelListing', 'inventory'].includes(input.targetEntity)) {
      throw new Error(`Unknown targetEntity: ${input.targetEntity}`)
    }
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.importJob.create({
        data: {
          jobName: input.jobName.trim(),
          description: input.description ?? null,
          source: input.source,
          sourceUrl: input.sourceUrl ?? null,
          filename: input.filename ?? null,
          fileKind: input.fileKind,
          targetEntity: input.targetEntity,
          columnMapping: input.columnMapping as never,
          onError: input.onError ?? 'skip',
          status: 'PENDING_PREVIEW',
          totalRows: input.rows.length,
          scheduleId: input.scheduleId ?? null,
          parentJobId: input.parentJobId ?? null,
          createdBy: input.createdBy ?? null,
        },
      })
      if (input.rows.length > 0) {
        await tx.importJobRow.createMany({
          data: input.rows.map((r) => ({
            jobId: job.id,
            rowIndex: r.rowIndex,
            parsedValues: r.values as never,
            status: r.parseError ? 'FAILED' : 'PENDING',
            errorMessage: r.parseError ?? null,
          })),
        })
      }
      return job
    })
  }

  async get(id: string): Promise<ImportJob | null> {
    return this.prisma.importJob.findUnique({ where: { id } })
  }

  async listRows(
    jobId: string,
    filter: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<ImportJobRow[]> {
    return this.prisma.importJobRow.findMany({
      where: {
        jobId,
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { rowIndex: 'asc' },
      take: Math.min(Math.max(filter.limit ?? 100, 1), 1000),
      skip: filter.offset ?? 0,
    })
  }

  async list(
    filter: { status?: string; limit?: number } = {},
  ): Promise<ImportJob[]> {
    return this.prisma.importJob.findMany({
      where: filter.status ? { status: filter.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filter.limit ?? 100, 1), 500),
    })
  }

  /**
   * Apply the import. Walks PENDING rows, calls the entity-specific
   * write path, flips per-row status + bumps job aggregates.
   *
   * Apply is the only path that mutates the catalog — `rows` rows
   * already in FAILED (parse-error) stay FAILED and never touch DB.
   */
  async apply(
    jobId: string,
  ): Promise<ApplyResult> {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } })
    if (!job) throw new Error(`ImportJob not found: ${jobId}`)
    if (
      job.status !== 'PENDING_PREVIEW' &&
      job.status !== 'PARTIAL' // allow retry of an aborted apply
    ) {
      throw new Error(`Cannot apply job in status ${job.status}`)
    }

    await this.prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'APPLYING', startedAt: new Date() },
    })

    const pending = await this.prisma.importJobRow.findMany({
      where: { jobId, status: 'PENDING' },
      orderBy: { rowIndex: 'asc' },
    })

    let success = 0
    let failed = 0
    let skipped = 0
    let aborted = false

    for (const row of pending) {
      try {
        const writeResult = await this.writeRow(
          job.targetEntity as TargetEntity,
          row.parsedValues as Record<string, unknown>,
        )
        await this.prisma.importJobRow.update({
          where: { id: row.id },
          data: {
            status: 'SUCCESS',
            targetId: writeResult.targetId,
            beforeState: writeResult.beforeState as never,
            afterState: writeResult.afterState as never,
            completedAt: new Date(),
          },
        })
        success++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await this.prisma.importJobRow.update({
          where: { id: row.id },
          data: {
            status: 'FAILED',
            errorMessage: message,
            completedAt: new Date(),
          },
        })
        failed++
        if (job.onError === 'abort') {
          aborted = true
          // Rest of pending rows stay PENDING — they didn't actually
          // get tried. Don't re-mark them.
          break
        }
      }
    }

    // Carry over already-FAILED rows from parse-time into the
    // failed total so the aggregate matches what the UI shows.
    const parseFailed = await this.prisma.importJobRow.count({
      where: { jobId, status: 'FAILED', completedAt: null },
    })
    failed += parseFailed
    skipped =
      job.totalRows - success - failed - (aborted ? pending.length - success - (failed - parseFailed) : 0)
    if (skipped < 0) skipped = 0

    let finalStatus: string
    if (aborted) {
      finalStatus = success > 0 ? 'PARTIAL' : 'FAILED'
    } else if (failed === 0) {
      finalStatus = 'COMPLETED'
    } else if (success > 0) {
      finalStatus = 'PARTIAL'
    } else {
      finalStatus = 'FAILED'
    }

    const updated = await this.prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: finalStatus,
        successRows: success,
        failedRows: failed,
        skippedRows: skipped,
        completedAt: new Date(),
      },
    })

    return {
      jobId: updated.id,
      status: updated.status,
      totalRows: updated.totalRows,
      successRows: updated.successRows,
      failedRows: updated.failedRows,
      skippedRows: updated.skippedRows,
    }
  }

  /**
   * Fork a job's FAILED rows into a new ImportJob (PENDING_PREVIEW)
   * pointing back at the original via parentJobId. Operator reviews
   * + applies the retry exactly like a fresh import.
   */
  async retryFailed(originalJobId: string): Promise<ImportJob> {
    const original = await this.prisma.importJob.findUnique({
      where: { id: originalJobId },
    })
    if (!original) throw new Error(`ImportJob not found: ${originalJobId}`)
    const failedRows = await this.prisma.importJobRow.findMany({
      where: { jobId: originalJobId, status: 'FAILED' },
      orderBy: { rowIndex: 'asc' },
    })
    if (failedRows.length === 0) {
      throw new Error('No FAILED rows to retry')
    }
    return this.create({
      jobName: `${original.jobName} (retry)`,
      description: original.description,
      source: 'upload',
      sourceUrl: null,
      filename: original.filename,
      fileKind: original.fileKind as FileKind,
      targetEntity: original.targetEntity as TargetEntity,
      columnMapping: original.columnMapping as Record<string, string>,
      onError: original.onError as OnErrorMode,
      rows: failedRows.map((r) => ({
        rowIndex: r.rowIndex,
        values: r.parsedValues as Record<string, unknown>,
      })),
      parentJobId: original.id,
      createdBy: original.createdBy,
    })
  }

  /**
   * Per-entity write path. Returns the target id + before/after
   * snapshots so the row's beforeState lights up rollback.
   *
   * v0 supports `product` only — channelListing + inventory paths
   * land in W8.3 once the UI surfaces them. The rest of the W8
   * pipeline is entity-agnostic, so adding a new entity is one
   * branch here.
   */
  private async writeRow(
    targetEntity: TargetEntity,
    values: Record<string, unknown>,
  ): Promise<{
    targetId: string
    beforeState: Record<string, unknown> | null
    afterState: Record<string, unknown> | null
  }> {
    if (targetEntity !== 'product') {
      throw new Error(
        `targetEntity '${targetEntity}' write path not yet implemented`,
      )
    }
    const sku = values.sku
    if (typeof sku !== 'string' || !sku.trim()) {
      throw new Error('row missing sku')
    }
    const existing = await this.prisma.product.findUnique({
      where: { sku: sku.trim() },
    })
    if (!existing) {
      throw new Error(`No product with sku=${sku.trim()}`)
    }
    // Whitelist what an import can touch on Product. Keeps the
    // write-path safe + makes mapping decisions explicit.
    const ALLOWED_FIELDS = new Set([
      'name',
      'brand',
      'description',
      'basePrice',
      'costPrice',
      'minPrice',
      'maxPrice',
      'totalStock',
      'lowStockThreshold',
      'status',
      'productType',
      'hsCode',
      'countryOfOrigin',
    ])
    const data: Record<string, unknown> = {}
    const beforeState: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(values)) {
      if (k === 'sku' || !ALLOWED_FIELDS.has(k)) continue
      if (v === undefined || v === null || v === '') continue
      data[k] = v
      beforeState[k] = (existing as unknown as Record<string, unknown>)[k]
    }
    if (Object.keys(data).length === 0) {
      throw new Error('row carries no writable fields')
    }
    const updated = await this.prisma.product.update({
      where: { id: existing.id },
      data: data as never,
    })
    const afterState: Record<string, unknown> = {}
    for (const k of Object.keys(data)) {
      afterState[k] = (updated as unknown as Record<string, unknown>)[k]
    }
    return {
      targetId: existing.id,
      beforeState,
      afterState,
    }
  }

  /**
   * Roll back every SUCCESS row by re-applying its beforeState.
   * Creates a new ImportJob marked as a retry-of-rollback so the
   * audit chain is clear. Best-effort per row.
   */
  async rollback(jobId: string): Promise<ApplyResult> {
    const job = await this.prisma.importJob.findUnique({
      where: { id: jobId },
    })
    if (!job) throw new Error(`ImportJob not found: ${jobId}`)
    if (job.status === 'PENDING_PREVIEW' || job.status === 'APPLYING') {
      throw new Error(`Cannot rollback job in status ${job.status}`)
    }
    const successRows = await this.prisma.importJobRow.findMany({
      where: { jobId, status: 'SUCCESS' },
      orderBy: { rowIndex: 'asc' },
    })
    if (successRows.length === 0) {
      throw new Error('No SUCCESS rows to roll back')
    }
    const rollbackJob = await this.create({
      jobName: `${job.jobName} (rollback)`,
      description: job.description,
      source: 'upload',
      filename: job.filename,
      fileKind: job.fileKind as FileKind,
      targetEntity: job.targetEntity as TargetEntity,
      columnMapping: job.columnMapping as Record<string, string>,
      onError: 'skip',
      // Replay each SUCCESS row's beforeState as the new "values"
      // — same write-path code, opposite direction.
      rows: successRows.map((r) => ({
        rowIndex: r.rowIndex,
        values: {
          ...((r.beforeState as Record<string, unknown>) ?? {}),
          // The write-path looks up by sku, which lives in
          // parsedValues.sku — pull it forward so the lookup still
          // resolves the same product.
          sku: (r.parsedValues as Record<string, unknown>).sku,
        },
      })),
      parentJobId: job.id,
      createdBy: 'rollback',
    })
    const result = await this.apply(rollbackJob.id)
    logger.info(
      `[import-wizard] rollback of ${jobId} → ${rollbackJob.id} (${result.successRows} reverted, ${result.failedRows} failed)`,
    )
    return result
  }
}
