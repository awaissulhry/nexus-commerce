/**
 * W8.4 — Scheduled imports.
 *
 * Recurring URL / FTP pulls that hand the fetched payload to the
 * W8.1 import service. Mirrors ScheduledBulkActionService's shape
 * but for imports — same one-time / recurring / cron-with-start-gate
 * dispatch logic.
 *
 * v0 supports source='url' over plain HTTP(S). 'ftp' is in the
 * schema but rejected at create time so operators don't queue a
 * fetch path that doesn't exist yet — the FTP client itself is a
 * follow-up commit.
 */

import type { PrismaClient, ScheduledImport } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  ImportWizardService,
  type FileKind,
  type TargetEntity,
  type OnErrorMode,
} from './import-wizard.service.js'
import {
  detectFileKind,
  parseFile,
} from './import/parsers.js'
import { applyMapping } from './import/column-mapping.js'

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
  targetEntity: TargetEntity
  columnMapping: Record<string, string>
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
  private importService: ImportWizardService
  constructor(private prisma: PrismaClient = prisma) {
    this.importService = new ImportWizardService(prisma)
  }

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
        columnMapping: input.columnMapping as never,
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
  } = {}): Promise<ScheduledImport[]> {
    const where: any = {}
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

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledImport> {
    const existing = await this.prisma.scheduledImport.findUnique({
      where: { id },
    })
    if (!existing) throw new Error(`ScheduledImport not found: ${id}`)
    let nextRunAt: Date | null = null
    if (enabled) nextRunAt = await computeNextRun(existing, new Date())
    return this.prisma.scheduledImport.update({
      where: { id },
      data: { enabled, nextRunAt },
    })
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

  /**
   * Fetch the URL, parse it, persist + apply the resulting
   * ImportJob. Returns the new ImportJob row's id so the schedule's
   * lastJobId pointer can record what fired.
   */
  async fireOnce(row: ScheduledImport): Promise<{
    jobId: string
    status: string
    successRows: number
    failedRows: number
  }> {
    const fileKind: FileKind = detectFileKind(row.sourceUrl)
    let text: string | undefined
    let bytes: Uint8Array | undefined
    const res = await fetch(row.sourceUrl)
    if (!res.ok) {
      throw new Error(`Fetch ${row.sourceUrl} failed: HTTP ${res.status}`)
    }
    if (fileKind === 'xlsx') {
      const ab = await res.arrayBuffer()
      bytes = new Uint8Array(ab)
    } else {
      text = await res.text()
    }
    const parsed = await parseFile(fileKind, { text, bytes })
    const mapping = (row.columnMapping as Record<string, string>) ?? {}
    const rows = parsed.rows.map((raw, i) => {
      const values = applyMapping(raw, mapping)
      let parseError: string | undefined
      if (
        row.targetEntity === 'product' &&
        (!values.sku || String(values.sku).trim().length === 0)
      ) {
        parseError = 'row missing sku (no value mapped to the SKU field)'
      }
      return { rowIndex: i + 1, values, parseError }
    })

    const job = await this.importService.create({
      jobName: `[scheduled] ${row.name}`,
      description: row.description,
      source: 'url',
      sourceUrl: row.sourceUrl,
      filename: row.sourceUrl.split('/').pop() ?? null,
      fileKind,
      targetEntity: row.targetEntity as TargetEntity,
      columnMapping: mapping,
      onError: row.onError as OnErrorMode,
      rows,
      scheduleId: row.id,
      createdBy: 'scheduled-import',
    })
    const result = await this.importService.apply(job.id)
    return {
      jobId: job.id,
      status: result.status,
      successRows: result.successRows,
      failedRows: result.failedRows,
    }
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
    const nextRunAt = await computeNextRun(
      { ...existing, runCount: newRunCount },
      now,
    )
    await this.prisma.scheduledImport
      .update({
        where: { id },
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
