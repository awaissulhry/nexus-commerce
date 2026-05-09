/**
 * W6.1 — ScheduledBulkAction service.
 *
 * Owns CRUD + the scheduler-side helpers (compute next run, mark
 * fired, handle pause/resume). The minute-tick worker (W6.2) reads
 * `findDueSchedules` to discover work, then calls
 * BulkActionService.createJob to execute and `markFired` to advance
 * the cursor.
 *
 * cron-parser handles the cron-expression maths. Validation at
 * create time rejects bad expressions before they reach the
 * scheduler so invalid rows can never wedge the tick.
 */

import type { PrismaClient, ScheduledBulkAction } from '@prisma/client'
import prisma from '../db.js'
import {
  isKnownBulkActionType,
  type BulkActionType,
} from './bulk-action.service.js'
import { logger } from '../utils/logger.js'

// cron-parser is exposed as a single default export with a
// `parseExpression` function. Imported lazily inside computeNextRun
// so the service module is testable without it (and so a missing
// dep at boot fails clearly instead of silently).
async function parseCron(
  expression: string,
  options: { tz?: string; currentDate?: Date } = {},
): Promise<{ next: () => { toDate: () => Date } }> {
  const mod = await import('cron-parser')
  const parser = (mod as any).default ?? mod
  return parser.parseExpression(expression, {
    tz: options.tz,
    currentDate: options.currentDate,
  })
}

export interface CreateScheduleInput {
  name: string
  description?: string | null
  actionType: BulkActionType
  channel?: string | null
  actionPayload?: Record<string, unknown>
  targetProductIds?: string[]
  targetVariationIds?: string[]
  filters?: Record<string, unknown> | null
  /** ISO-8601 datetime, or undefined for purely-recurring schedules. */
  scheduledFor?: string | Date | null
  /** Standard 5-field cron expression. */
  cronExpression?: string | null
  /** IANA timezone, default Europe/Rome. */
  timezone?: string
  templateId?: string | null
  createdBy?: string | null
}

/**
 * Validate a cron expression by parsing it. Throws when the parser
 * rejects the input — caller should map to a 400 at the route layer.
 */
export async function validateCronExpression(
  expr: string,
  tz: string,
): Promise<void> {
  try {
    await parseCron(expr, { tz })
  } catch (err) {
    throw new Error(
      `Invalid cron expression '${expr}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Compute the timestamp the scheduler should fire next, given a row's
 * current state. Returns null when the schedule is exhausted (one-
 * time, already fired) or has no future runs.
 *
 *   one-time, never fired       → scheduledFor
 *   one-time, already fired     → null (one-shot done)
 *   recurring                   → cron next-after `from`
 *   recurring + scheduledFor    → max(scheduledFor, cron next-after from)
 */
export async function computeNextRun(
  row: {
    scheduledFor: Date | null
    cronExpression: string | null
    timezone: string
    runCount: number
  },
  from: Date = new Date(),
): Promise<Date | null> {
  // One-time only: fire once at scheduledFor, then exhaust.
  if (!row.cronExpression) {
    if (!row.scheduledFor) return null
    if (row.runCount > 0) return null
    return row.scheduledFor
  }
  // Recurring path. Compute the next cron occurrence after `from`.
  const interval = await parseCron(row.cronExpression, {
    tz: row.timezone,
    currentDate: from,
  })
  const cronNext = interval.next().toDate()
  if (row.scheduledFor && cronNext < row.scheduledFor) {
    // Wait for the start gate before honoring the cron.
    return row.scheduledFor
  }
  return cronNext
}

export class ScheduledBulkActionService {
  constructor(private prisma: PrismaClient = prisma) {}

  async create(input: CreateScheduleInput): Promise<ScheduledBulkAction> {
    if (!input.name || !input.name.trim()) {
      throw new Error('name is required')
    }
    if (!isKnownBulkActionType(input.actionType)) {
      throw new Error(
        `actionType '${input.actionType}' is not in KNOWN_BULK_ACTION_TYPES`,
      )
    }
    const tz = input.timezone ?? 'Europe/Rome'
    if (input.cronExpression) {
      await validateCronExpression(input.cronExpression, tz)
    }
    if (!input.scheduledFor && !input.cronExpression) {
      throw new Error(
        'Schedule must carry either scheduledFor or cronExpression',
      )
    }
    const scheduledForDate = input.scheduledFor
      ? new Date(input.scheduledFor)
      : null
    const nextRunAt = await computeNextRun({
      scheduledFor: scheduledForDate,
      cronExpression: input.cronExpression ?? null,
      timezone: tz,
      runCount: 0,
    })
    return this.prisma.scheduledBulkAction.create({
      data: {
        name: input.name.trim(),
        description: input.description ?? null,
        actionType: input.actionType,
        channel: input.channel ?? null,
        actionPayload: (input.actionPayload ?? {}) as never,
        targetProductIds: input.targetProductIds ?? [],
        targetVariationIds: input.targetVariationIds ?? [],
        filters: (input.filters ?? null) as never,
        scheduledFor: scheduledForDate,
        cronExpression: input.cronExpression ?? null,
        timezone: tz,
        nextRunAt,
        enabled: true,
        templateId: input.templateId ?? null,
        createdBy: input.createdBy ?? null,
      },
    })
  }

  async list(filters: {
    enabled?: boolean
    actionType?: string
    templateId?: string
    limit?: number
  } = {}): Promise<ScheduledBulkAction[]> {
    const where: any = {}
    if (filters.enabled !== undefined) where.enabled = filters.enabled
    if (filters.actionType) where.actionType = filters.actionType
    if (filters.templateId) where.templateId = filters.templateId
    return this.prisma.scheduledBulkAction.findMany({
      where,
      orderBy: [{ nextRunAt: 'asc' }, { updatedAt: 'desc' }],
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    })
  }

  async get(id: string): Promise<ScheduledBulkAction | null> {
    return this.prisma.scheduledBulkAction.findUnique({ where: { id } })
  }

  /**
   * Pause / resume. Pausing nullifies nextRunAt; resuming recomputes
   * from cronExpression / scheduledFor. Both ops bump updatedAt so
   * the schedule UI's "last touched" sort stays meaningful.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ScheduledBulkAction> {
    const existing = await this.prisma.scheduledBulkAction.findUnique({
      where: { id },
    })
    if (!existing) throw new Error(`Schedule not found: ${id}`)
    let nextRunAt: Date | null = null
    if (enabled) {
      nextRunAt = await computeNextRun(existing, new Date())
    }
    return this.prisma.scheduledBulkAction.update({
      where: { id },
      data: { enabled, nextRunAt },
    })
  }

  async delete(id: string): Promise<void> {
    await this.prisma.scheduledBulkAction.delete({ where: { id } }).catch(() => {
      // swallow not-found — DELETE is idempotent at the route layer
    })
  }

  /**
   * The scheduler tick uses this to find rows ready to fire. Bounded
   * limit keeps a clogged tick from spending forever in one window.
   */
  async findDueSchedules(now: Date, limit = 50): Promise<ScheduledBulkAction[]> {
    return this.prisma.scheduledBulkAction.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now, not: null },
      },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
    })
  }

  /**
   * Mark a schedule as fired. Updates lastRunAt / lastJobId / lastStatus,
   * bumps runCount, and recomputes nextRunAt for recurring rows. One-
   * time schedules get nextRunAt=null after fire (exhausted). Best-
   * effort: returns the row but never throws on mutation errors —
   * the worker logs and moves on so one bad row doesn't wedge the tick.
   */
  async markFired(
    id: string,
    result: { jobId: string | null; status: string; error?: string | null },
  ): Promise<ScheduledBulkAction | null> {
    const existing = await this.prisma.scheduledBulkAction.findUnique({
      where: { id },
    })
    if (!existing) return null
    const newRunCount = existing.runCount + 1
    const now = new Date()
    const nextRunAt = await computeNextRun(
      { ...existing, runCount: newRunCount },
      now,
    )
    return this.prisma.scheduledBulkAction
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
          `[scheduled-bulk-action] markFired update failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        )
        return null
      })
  }
}
