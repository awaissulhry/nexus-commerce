/**
 * W9.1 — Export wizard service.
 *
 * Mirror of the import side: persist + run + ship the artifact for
 * an ExportJob. The renderers (W9.2) do the format-specific
 * encoding; this service handles row fetching, lifecycle status,
 * and the inline-vs-URL artifact split.
 *
 * Pipeline:
 *
 *   create()    Persist a PENDING ExportJob and (in v0) immediately
 *               run it inline. Larger exports could move this to a
 *               BullMQ worker later.
 *
 *   run()       Fetch rows from the catalog using the operator's
 *               filters + columns, hand to the renderer, store the
 *               result. Inline base64 for small payloads (<1 MB);
 *               artifactUrl for the rest via ArtifactStore (F8 fix).
 *
 *   download()  Decode the inline payload (or fetch via ArtifactStore)
 *               and return bytes. Used by both the W9.3 download path
 *               and the W9.4 scheduled-export delivery hook.
 */

import type {
  ExportJob,
  Prisma,
  PrismaClient,
} from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { renderExport, type ColumnSpec, type ExportFormat } from './export/renderers.js'
import { buildCatalogWorkbook } from './flat-file/workbook.service.js'
import { getArtifactStore } from './flat-file/artifact-store.js'

export type TargetEntity = 'product' | 'channelListing' | 'inventory' | 'catalog'

const INLINE_PAYLOAD_LIMIT_BYTES = 1_000_000

export interface CreateExportInput {
  jobName: string
  description?: string | null
  format: ExportFormat
  targetEntity: TargetEntity
  columns: ColumnSpec[]
  filters?: Record<string, unknown> | null
  scheduleId?: string | null
  createdBy?: string | null
  /** When true, run() the job inline before returning. Default true
   *  for the operator path; W9.4's worker calls with false to keep
   *  the create + run separable for retries. */
  runImmediately?: boolean
}

export interface DownloadResult {
  filename: string
  contentType: string
  bytes: Buffer
  rowCount: number
}

export class ExportWizardService {
  constructor(private prisma: PrismaClient = prisma) {}

  async create(input: CreateExportInput): Promise<ExportJob> {
    if (!input.jobName?.trim()) throw new Error('jobName is required')
    if (!['csv', 'xlsx', 'json', 'pdf', 'workbook'].includes(input.format)) {
      throw new Error(`Unknown format: ${input.format}`)
    }
    if (!['product', 'channelListing', 'inventory', 'catalog'].includes(input.targetEntity)) {
      throw new Error(`Unknown targetEntity: ${input.targetEntity}`)
    }
    // columns are required for all formats EXCEPT 'workbook' (registry-driven)
    if (input.format !== 'workbook') {
      if (!Array.isArray(input.columns) || input.columns.length === 0) {
        throw new Error('columns is required (non-empty)')
      }
    }
    // workbook format and catalog entity must always go together
    if ((input.format === 'workbook') !== (input.targetEntity === 'catalog')) {
      throw new Error('workbook format requires targetEntity=catalog (and vice versa)')
    }
    const job = await this.prisma.exportJob.create({
      data: {
        jobName: input.jobName.trim(),
        description: input.description ?? null,
        format: input.format,
        targetEntity: input.targetEntity,
        columns: input.columns as never,
        filters: (input.filters ?? null) as never,
        status: 'PENDING',
        scheduleId: input.scheduleId ?? null,
        createdBy: input.createdBy ?? null,
      },
    })
    if (input.runImmediately !== false) {
      try {
        await this.run(job.id)
      } catch (err) {
        logger.error(
          `[export-wizard] run failed for ${job.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return this.prisma.exportJob.findUnique({ where: { id: job.id } }) as Promise<ExportJob>
  }

  async get(id: string): Promise<ExportJob | null> {
    return this.prisma.exportJob.findUnique({ where: { id } })
  }

  async list(filters: { status?: string; limit?: number } = {}): Promise<ExportJob[]> {
    return this.prisma.exportJob.findMany({
      where: filters.status ? { status: filters.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    })
  }

  /**
   * F8 fix: route large artifacts through ArtifactStore rather than base64-in-Postgres.
   * Small payloads (<1 MB) stay inline for zero-dep retrieval.
   */
  private async storeArtifact(
    bytes: Uint8Array,
    key: string,
    contentType: string,
  ): Promise<{ artifactBase64: string | null; artifactUrl: string | null }> {
    if (bytes.byteLength <= INLINE_PAYLOAD_LIMIT_BYTES) {
      return { artifactBase64: Buffer.from(bytes).toString('base64'), artifactUrl: null }
    }
    const handle = await getArtifactStore().put(key, bytes, contentType)
    return { artifactBase64: null, artifactUrl: handle }
  }

  /** Fetch rows from the target entity per the saved filters. */
  private async fetchRows(
    targetEntity: TargetEntity,
    filters: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>[]> {
    if (targetEntity === 'product') {
      const where: Prisma.ProductWhereInput = {}
      if (filters && typeof filters === 'object') {
        if (typeof filters.status === 'string') {
          where.status = filters.status
        }
        if (typeof filters.brand === 'string') {
          where.brand = filters.brand
        }
        if (typeof filters.productType === 'string') {
          where.productType = filters.productType
        }
        if (Array.isArray(filters.skuIn)) {
          where.sku = { in: filters.skuIn as string[] }
        }
      }
      const products = await this.prisma.product.findMany({
        where,
        orderBy: { sku: 'asc' },
        take: 50_000, // hard cap; bigger exports route through chunked path later
      })
      return products as unknown as Record<string, unknown>[]
    }
    // Other entities supported in a follow-up — caller validates
    // targetEntity at create time so this branch should never hit
    // in v0.
    throw new Error(`fetchRows: targetEntity '${targetEntity}' not yet supported`)
  }

  async run(jobId: string): Promise<ExportJob> {
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } })
    if (!job) throw new Error(`ExportJob not found: ${jobId}`)
    if (job.status !== 'PENDING') {
      throw new Error(`Cannot run job in status ${job.status}`)
    }
    await this.prisma.exportJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    })
    try {
      // ── Workbook path (FF1.11) ────────────────────────────────────────────
      // Handled before fetchRows because 'catalog' is not a generic entity
      // and the workbook builder orchestrates its own DB queries.
      if (job.format === 'workbook' || job.targetEntity === 'catalog') {
        const filters = (job.filters as Record<string, unknown> | null) ?? {}
        const channels = (
          Array.isArray(filters.channels) ? filters.channels : ['AMAZON', 'EBAY', 'SHOPIFY']
        ) as ('AMAZON' | 'EBAY' | 'SHOPIFY')[]
        const exportedAt = new Date(job.createdAt).toISOString().slice(0, 10)
        const { bytes, marketList } = await buildCatalogWorkbook(this.prisma, {
          channels,
          filters: {
            status: filters.status as string | undefined,
            brand: filters.brand as string | undefined,
            productType: filters.productType as string | undefined,
            skuIn: filters.skuIn as string[] | undefined,
          },
          snapshotId: job.id,
          exportedAt,
          blankTemplate: filters.blankTemplate === true,
        })
        const stored = await this.storeArtifact(
          bytes,
          `${job.id}.xlsx`,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        return this.prisma.exportJob.update({
          where: { id: jobId },
          data: {
            status: 'COMPLETED',
            rowCount: 0,
            bytes: bytes.byteLength,
            snapshotId: job.id,
            marketList: marketList as never,
            artifactBase64: stored.artifactBase64,
            artifactUrl: stored.artifactUrl,
            completedAt: new Date(),
          },
        })
      }

      // ── Generic path (csv / xlsx / json / pdf) ────────────────────────────
      const rows = await this.fetchRows(
        job.targetEntity as TargetEntity,
        (job.filters as Record<string, unknown> | null) ?? null,
      )
      const rendered = await renderExport({
        format: job.format as ExportFormat,
        columns:
          (job.columns as unknown as ColumnSpec[] | null) ?? [],
        rows,
        filename: job.jobName,
      })
      const bytes = rendered.bytes
      // Determine MIME for ArtifactStore (mirrors download() logic)
      const mime =
        job.format === 'csv'
          ? 'text/csv'
          : job.format === 'tsv'
            ? 'text/tab-separated-values'
            : job.format === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : job.format === 'json'
                ? 'application/json'
                : 'application/pdf'
      const stored = await this.storeArtifact(bytes, `${job.id}`, mime)
      return this.prisma.exportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          rowCount: rows.length,
          bytes: bytes.byteLength,
          artifactBase64: stored.artifactBase64,
          artifactUrl: stored.artifactUrl,
          completedAt: new Date(),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.prisma.exportJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: message,
          completedAt: new Date(),
        },
      })
      throw err
    }
  }

  async download(jobId: string): Promise<DownloadResult | null> {
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } })
    if (!job || job.status !== 'COMPLETED') return null
    let bytes: Buffer
    if (job.artifactBase64) {
      bytes = Buffer.from(job.artifactBase64, 'base64')
    } else if (job.artifactUrl) {
      // ArtifactStore handles (local:... / S3 keys) are NOT http URLs — use the store.
      const got = await getArtifactStore().get(job.artifactUrl)
      if (!got) return null
      bytes = Buffer.from(got)
    } else {
      return null
    }
    const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const contentType =
      job.format === 'csv'
        ? 'text/csv'
        : job.format === 'tsv'
          ? 'text/tab-separated-values'
          : job.format === 'xlsx' || job.format === 'workbook'
            ? XLSX_MIME
            : job.format === 'json'
              ? 'application/json'
              : 'application/pdf'
    const ext =
      job.format === 'xlsx' || job.format === 'workbook'
        ? 'xlsx'
        : job.format === 'pdf'
          ? 'pdf'
          : job.format
    const safeName = job.jobName.replace(/[^a-z0-9_\-]+/gi, '_')
    return {
      filename: `${safeName}.${ext}`,
      contentType,
      bytes,
      rowCount: job.rowCount,
    }
  }

  async delete(id: string): Promise<void> {
    await this.prisma.exportJob.delete({ where: { id } }).catch(() => {})
  }
}
