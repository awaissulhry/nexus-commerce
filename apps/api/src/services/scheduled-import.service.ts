/**
 * Scheduled URL sources use the same immutable review and versioned writer
 * as manual imports. FTP and legacy unversioned mappings are refused.
 */

import type { PrismaClient, ScheduledImport } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import type { OnErrorMode } from './import-wizard.service.js'
import { validateSourceMapping, mapSourceTable, type SourceMapping } from './pim/catalog-source-mapping.js'
import { PRESET_KIND } from './pim/catalog-source.service.js'
import { readSourceFile } from './pim/catalog-source-file.js'
import { fetchCatalogSource } from './pim/catalog-source-fetch.js'
import { stageTransferJob, readTransferJob, transferJobStatus } from './pim/catalog-transfer-jobs.js'
import { fingerprint } from './pim/catalog-transfer-plan.js'
import { TransferConflict } from './pim/catalog-transfer.service.js'

async function parseCron(
  expression: string,
  options: { tz?: string; currentDate?: Date } = {},
) {
  const mod = await import('cron-parser')
  const parser = (mod as any).default ?? mod
  return parser.parseExpression(expression, {
    tz: options.tz,
    currentDate: options.currentDate,
  })
}

export interface CreateScheduledImportInput {
  name: string
  description?: string | null
  source: 'url' | 'ftp'
  sourceUrl: string
  targetEntity: string
  columnMapping: SourceMapping
  onError?: OnErrorMode
  scheduledFor?: string | Date | null
  cronExpression?: string | null
  timezone?: string
  createdBy?: string | null
}

export async function computeNextRun(
  row: {
    scheduledFor: Date | null
    cronExpression: string | null
    timezone: string
    runCount: number
  },
  from: Date = new Date(),
): Promise<Date | null> {
  if (!row.cronExpression) {
    if (!row.scheduledFor) return null
    if (row.runCount > 0) return null
    return row.scheduledFor
  }
  const interval = await parseCron(row.cronExpression, {
    tz: row.timezone,
    currentDate: from,
  })
  const cronNext = interval.next().toDate()
  if (row.scheduledFor && cronNext < row.scheduledFor) {
    return row.scheduledFor
  }
  return cronNext
}

export class ScheduledImportService {
  constructor(private prisma: PrismaClient = prisma) {}

  async create(input: CreateScheduledImportInput): Promise<ScheduledImport> {
    if (!input.name || !input.name.trim()) {
      throw new Error('name is required')
    }
    if (input.source !== 'url' && input.source !== 'ftp') {
      throw new Error(`Unknown source: ${input.source}`)
    }
    if (input.source === 'ftp') {
      throw new Error('FTP source not yet supported — use URL')
    }
    if (!input.sourceUrl || !/^https?:\/\//i.test(input.sourceUrl)) {
      throw new Error('sourceUrl must be a http(s) URL')
    }
    const mapping = validateSourceMapping(input.columnMapping)
    if (input.targetEntity !== PRESET_KIND) throw new TransferConflict('Select a catalog source mapping with a declared ownership policy')
    const tz = input.timezone ?? 'Europe/Rome'
    if (input.cronExpression) {
      try {
        await parseCron(input.cronExpression, { tz })
      } catch (err) {
        throw new Error(
          `Invalid cron expression '${input.cronExpression}': ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (!input.scheduledFor && !input.cronExpression) {
      throw new Error('Schedule must carry either scheduledFor or cronExpression')
    }
    const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null
    if (scheduledFor && !Number.isFinite(scheduledFor.getTime())) throw new Error('Invalid scheduled date')
    const nextRunAt = await computeNextRun({
      scheduledFor,
      cronExpression: input.cronExpression ?? null,
      timezone: tz,
      runCount: 0,
    })
    return this.prisma.scheduledImport.create({
      data: {
        name: input.name.trim(),
        description: input.description ?? null,
        source: input.source,
        sourceUrl: input.sourceUrl,
        targetEntity: input.targetEntity,
        columnMapping: mapping as never,
        onError: input.onError ?? 'skip',
        cronExpression: input.cronExpression ?? null,
        scheduledFor,
        timezone: tz,
        nextRunAt,
        enabled: true,
        createdBy: input.createdBy ?? null,
      },
    })
  }

  async list(filters: {
    enabled?: boolean
    limit?: number
    userId?: string | null
  } = {}): Promise<ScheduledImport[]> {
    const where: any = { source: { not: 'upload' }, ...(filters.userId !== undefined ? { createdBy: filters.userId } : {}) }
    if (filters.enabled !== undefined) where.enabled = filters.enabled
    return this.prisma.scheduledImport.findMany({
      where,
      orderBy: [{ nextRunAt: 'asc' }, { updatedAt: 'desc' }],
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    })
  }

  async get(id: string): Promise<ScheduledImport | null> {
    return this.prisma.scheduledImport.findUnique({ where: { id } })
  }

  async setEnabled(id: string, enabled: boolean, version?: string): Promise<ScheduledImport> {
    const existing = await this.prisma.scheduledImport.findUnique({
      where: { id },
    })
    if (!existing) throw new Error(`ScheduledImport not found: ${id}`)
    if (!version || existing.updatedAt.toISOString() !== version) throw new TransferConflict('Schedule changed; reload before changing its state')
    if (enabled) {
      validateSourceMapping(existing.columnMapping)
      if (existing.targetEntity !== PRESET_KIND || existing.source !== 'url') throw new TransferConflict('Reconfigure this legacy schedule with a catalog source ownership policy')
    }
    const nextRunAt = enabled ? await computeNextRun(existing, new Date()) : null
    const changed = await this.prisma.scheduledImport.updateMany({ where: { id, updatedAt: existing.updatedAt }, data: { enabled, nextRunAt } })
    if (!changed.count) throw new TransferConflict('Schedule changed; reload it')
    return this.prisma.scheduledImport.findUniqueOrThrow({ where: { id } })
  }

  async deleteOwned(id: string, userId: string | null, version?: string): Promise<void> {
    const row = await this.get(id)
    if (!row || row.createdBy !== userId) throw new TransferConflict('Schedule not found')
    if (row.enabled || !version || version !== row.updatedAt.toISOString()) throw new TransferConflict('Pause the schedule and reload its current version before deleting it')
    const result = await this.prisma.scheduledImport.deleteMany({ where: { id, createdBy: userId, enabled: false, updatedAt: row.updatedAt } })
    if (!result.count) throw new TransferConflict('Schedule changed; reload it')
  }

  async delete(id: string): Promise<void> {
    await this.prisma.scheduledImport
      .delete({ where: { id } })
      .catch(() => {})
  }

  async findDue(now: Date, limit = 10): Promise<ScheduledImport[]> {
    return this.prisma.scheduledImport.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now, not: null },
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    })
  }

  /** Claim a source occurrence before fetching. Every run produces an immutable review. */
  async fireOnce(row: ScheduledImport): Promise<{ jobId: string; status: string; successRows: number; failedRows: number }> {
    const mapping = validateSourceMapping(row.columnMapping)
    if (row.targetEntity !== PRESET_KIND || row.source !== 'url') throw new TransferConflict('Legacy schedule needs an explicit catalog source ownership policy')
    const claimVersion = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1))
    const claim = await this.prisma.scheduledImport.updateMany({ where: { id: row.id, enabled: true, updatedAt: row.updatedAt }, data: { nextRunAt: new Date(Date.now() + 5 * 60_000), lastStatus: 'FETCHING', updatedAt: claimVersion, ...(row.lastStatus !== 'FETCHING' ? { lastJobId: null } : {}) } })
    if (!claim.count) throw new TransferConflict('Schedule already claimed or changed')
    // A crash after durable staging can reuse its job instead of fetching and writing again.
    if (row.lastStatus === 'FETCHING' && row.lastJobId) {
      const prior = await readTransferJob(row.lastJobId, row.createdBy)
      if (prior) return { jobId: row.lastJobId, status: transferJobStatus(prior).state, successRows: 0, failedRows: 0 }
    }
    const file = await fetchCatalogSource(row.sourceUrl)
    const mapped = mapSourceTable(await readSourceFile(file.buffer, file.filename), mapping)
    const current = await this.prisma.scheduledImport.findUnique({ where: { id: row.id } })
    if (!current?.enabled || fingerprint([current.columnMapping, current.sourceUrl]) !== fingerprint([row.columnMapping, row.sourceUrl])) throw new TransferConflict('Source policy changed while fetching')
    const job = await stageTransferJob({ ...mapped, mapping, mode: mapping.mode, market: mapping.market, filename: file.filename, userId: row.createdBy, scheduleClaimVersion: claimVersion,
      source: { url: row.sourceUrl, scheduleId: row.id, presetId: row.id, presetVersion: fingerprint([row.columnMapping, row.sourceUrl]), autoApply: mapping.execution === 'automatic' } })
    return { jobId: job.jobId, status: job.state, successRows: 0, failedRows: 0 }
  }

  async markFired(
    id: string,
    result: { jobId: string | null; status: string; error?: string | null },
  ): Promise<void> {
    const existing = await this.prisma.scheduledImport.findUnique({
      where: { id },
    })
    if (!existing) return
    const newRunCount = existing.runCount + 1
    const now = new Date()
    const nextRunAt = existing.enabled ? await computeNextRun(
      { ...existing, runCount: newRunCount },
      now,
    ) : null
    await this.prisma.scheduledImport
      .updateMany({
        where: { id, updatedAt: existing.updatedAt },
        data: {
          lastRunAt: now,
          lastJobId: result.jobId,
          lastStatus: result.status,
          lastError: result.error ?? null,
          runCount: newRunCount,
          nextRunAt,
        },
      })
      .catch((err) => {
        logger.error(
          `[scheduled-import] markFired update failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
  }
}
