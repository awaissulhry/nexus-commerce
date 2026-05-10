/**
 * W9.4 — Scheduled exports + delivery hook.
 *
 * Recurring export runs that hand the rendered artifact to a
 * delivery transport. Mirror of W8.4's ScheduledImportService:
 * one-time / recurring / cron-with-start-gate dispatch logic
 * with a tiny per-row firing path.
 *
 * v0 supports delivery='email' (logged to Notification — the
 * actual SMTP/Resend dispatch is gated behind the same
 * NEXUS_ENABLE_OUTBOUND_EMAILS flag the dashboard digest uses,
 * so dev never accidentally fires real mail). delivery='webhook'
 * POSTs the bytes to deliveryTarget. delivery='ftp' is in the
 * schema enum but rejected at create time so operators don't
 * queue a path that doesn't exist yet.
 */

import type { PrismaClient, ScheduledExport } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  ExportWizardService,
  type TargetEntity,
} from './export-wizard.service.js'
import type {
  ColumnSpec,
  ExportFormat,
} from './export/renderers.js'

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

export type DeliveryMode = 'email' | 'webhook' | 'ftp'

export interface CreateScheduledExportInput {
  name: string
  description?: string | null
  format: ExportFormat
  targetEntity: TargetEntity
  columns: ColumnSpec[]
  filters?: Record<string, unknown> | null
  delivery: DeliveryMode
  deliveryTarget?: string | null
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

export class ScheduledExportService {
  private exportService: ExportWizardService
  constructor(private prisma: PrismaClient = prisma) {
    this.exportService = new ExportWizardService(prisma)
  }

  async create(input: CreateScheduledExportInput): Promise<ScheduledExport> {
    if (!input.name || !input.name.trim()) {
      throw new Error('name is required')
    }
    if (!['csv', 'xlsx', 'json', 'pdf'].includes(input.format)) {
      throw new Error(`Unknown format: ${input.format}`)
    }
    if (!['product', 'channelListing', 'inventory'].includes(input.targetEntity)) {
      throw new Error(`Unknown targetEntity: ${input.targetEntity}`)
    }
    if (!Array.isArray(input.columns) || input.columns.length === 0) {
      throw new Error('columns is required (non-empty)')
    }
    if (!['email', 'webhook', 'ftp'].includes(input.delivery)) {
      throw new Error(`Unknown delivery: ${input.delivery}`)
    }
    if (input.delivery === 'ftp') {
      throw new Error('FTP delivery not yet supported — use email or webhook')
    }
    if (input.delivery === 'webhook') {
      if (!input.deliveryTarget || !/^https?:\/\//i.test(input.deliveryTarget)) {
        throw new Error('webhook delivery requires deliveryTarget as a http(s) URL')
      }
    }
    if (input.delivery === 'email') {
      // Allow blank target — we log to Notification regardless. But if
      // a target is supplied, sanity-check it's something email-shaped
      // so a copy/paste error doesn't silently swallow.
      if (
        input.deliveryTarget &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.deliveryTarget)
      ) {
        throw new Error('email delivery target must be a valid email address')
      }
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
    return this.prisma.scheduledExport.create({
      data: {
        name: input.name.trim(),
        description: input.description ?? null,
        format: input.format,
        targetEntity: input.targetEntity,
        columns: input.columns as never,
        filters: (input.filters ?? null) as never,
        delivery: input.delivery,
        deliveryTarget: input.deliveryTarget ?? null,
        cronExpression: input.cronExpression ?? null,
        scheduledFor,
        timezone: tz,
        nextRunAt,
        enabled: true,
        createdBy: input.createdBy ?? null,
      },
    })
  }

  async list(filters: { enabled?: boolean; limit?: number } = {}): Promise<ScheduledExport[]> {
    const where: any = {}
    if (filters.enabled !== undefined) where.enabled = filters.enabled
    return this.prisma.scheduledExport.findMany({
      where,
      orderBy: [{ nextRunAt: 'asc' }, { updatedAt: 'desc' }],
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    })
  }

  async get(id: string): Promise<ScheduledExport | null> {
    return this.prisma.scheduledExport.findUnique({ where: { id } })
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledExport> {
    const existing = await this.prisma.scheduledExport.findUnique({ where: { id } })
    if (!existing) throw new Error(`ScheduledExport not found: ${id}`)
    let nextRunAt: Date | null = null
    if (enabled) nextRunAt = await computeNextRun(existing, new Date())
    return this.prisma.scheduledExport.update({
      where: { id },
      data: { enabled, nextRunAt },
    })
  }

  async delete(id: string): Promise<void> {
    await this.prisma.scheduledExport
      .delete({ where: { id } })
      .catch(() => {})
  }

  async findDue(now: Date, limit = 10): Promise<ScheduledExport[]> {
    return this.prisma.scheduledExport.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now, not: null },
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    })
  }

  /**
   * Run the export inline + dispatch through the configured delivery
   * transport. Returns the firing summary so the cron tick can stamp
   * lastJobId / lastStatus on the schedule row.
   */
  async fireOnce(row: ScheduledExport): Promise<{
    jobId: string
    status: string
    bytes: number
    rowCount: number
  }> {
    const job = await this.exportService.create({
      jobName: `[scheduled] ${row.name}`,
      description: row.description,
      format: row.format as ExportFormat,
      targetEntity: row.targetEntity as TargetEntity,
      columns: (row.columns as unknown as ColumnSpec[] | null) ?? [],
      filters: (row.filters as Record<string, unknown> | null) ?? null,
      scheduleId: row.id,
      createdBy: 'scheduled-export',
      runImmediately: true,
    })
    if (job.status !== 'COMPLETED') {
      return {
        jobId: job.id,
        status: job.status,
        bytes: job.bytes,
        rowCount: job.rowCount,
      }
    }
    await this.deliver(row, job.id)
    return {
      jobId: job.id,
      status: job.status,
      bytes: job.bytes,
      rowCount: job.rowCount,
    }
  }

  /**
   * Hand the rendered artifact to the configured delivery transport.
   * 'email' logs a Notification (real SMTP send is gated behind the
   * existing NEXUS_ENABLE_OUTBOUND_EMAILS flag — out of scope for v0).
   * 'webhook' POSTs the bytes to deliveryTarget. Failures are recorded
   * but don't bubble — the export itself is still COMPLETED.
   */
  private async deliver(row: ScheduledExport, jobId: string): Promise<void> {
    if (row.delivery === 'email') {
      await this.deliverEmail(row, jobId)
      return
    }
    if (row.delivery === 'webhook') {
      await this.deliverWebhook(row, jobId)
      return
    }
    // 'ftp' rejected at create time so this branch should never hit.
  }

  private async deliverEmail(row: ScheduledExport, jobId: string): Promise<void> {
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } })
    if (!job) return
    const userId = row.createdBy ?? '__system__'
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          type: 'scheduled-export',
          severity: 'success',
          title: `Scheduled export ready: ${row.name}`,
          body: `Format ${job.format.toUpperCase()} · ${job.rowCount.toLocaleString()} rows · ${job.bytes.toLocaleString()} bytes${row.deliveryTarget ? ` · email target ${row.deliveryTarget}` : ''}`,
          entityType: 'ExportJob',
          entityId: job.id,
          meta: {
            scheduleId: row.id,
            deliveryTarget: row.deliveryTarget,
            format: job.format,
            rowCount: job.rowCount,
            bytes: job.bytes,
          },
          href: `/bulk-operations/exports`,
        },
      })
    } catch (err) {
      logger.warn(
        `[scheduled-export] notification log failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async deliverWebhook(row: ScheduledExport, jobId: string): Promise<void> {
    if (!row.deliveryTarget) return
    const dl = await this.exportService.download(jobId)
    if (!dl) return
    try {
      const res = await fetch(row.deliveryTarget, {
        method: 'POST',
        headers: {
          'Content-Type': dl.contentType,
          'Content-Disposition': `attachment; filename="${dl.filename}"`,
          'X-Nexus-Schedule-Id': row.id,
          'X-Nexus-Job-Id': jobId,
        },
        body: dl.bytes,
      })
      if (!res.ok) {
        throw new Error(`Webhook ${row.deliveryTarget} returned HTTP ${res.status}`)
      }
    } catch (err) {
      logger.warn(
        `[scheduled-export] webhook delivery failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async markFired(
    id: string,
    result: {
      jobId: string | null
      status: string
      bytes?: number
      rowCount?: number
      error?: string | null
    },
  ): Promise<void> {
    const existing = await this.prisma.scheduledExport.findUnique({ where: { id } })
    if (!existing) return
    const newRunCount = existing.runCount + 1
    const now = new Date()
    const nextRunAt = await computeNextRun(
      { ...existing, runCount: newRunCount },
      now,
    )
    await this.prisma.scheduledExport
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
          `[scheduled-export] markFired update failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
  }
}
