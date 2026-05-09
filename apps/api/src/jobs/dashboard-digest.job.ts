/**
 * DO.40 — Hourly cron that dispatches scheduled dashboard digest
 * emails.
 *
 * Reads ScheduledReport rows where:
 *   - isActive = true
 *   - the current Europe/Rome local hour matches `hourLocal`
 *   - frequency dictates whether enough time has passed since
 *     `lastSentAt`:
 *       daily   → previous fire was on a different calendar day
 *       weekly  → previous fire was in a different ISO week
 *       monthly → previous fire was in a different calendar month
 *
 * For each due row, generates the digest and emails via the shared
 * Resend transport (gated by NEXUS_ENABLE_OUTBOUND_EMAILS for
 * safety). On success, stamps lastSentAt so the row doesn't double-
 * fire if the cron tick runs twice in the same hour.
 *
 * Cron gate: NEXUS_ENABLE_DASHBOARD_DIGEST_CRON=1. Same gate
 * pattern as the other crons (forecast, refund-deadline, etc.).
 *
 * Manual trigger: POST /api/dashboard/digest/run (added in DO.40
 * for the operator's preview-and-test workflow).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  sendDigest,
  type DigestFrequency,
} from '../services/dashboard-digest.service.js'

const OPERATOR_TIMEZONE = 'Europe/Rome'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

interface ZonedNow {
  hour: number
  date: string // YYYY-MM-DD
  isoWeek: string // YYYY-Www
  yearMonth: string // YYYY-MM
}

function zonedNow(at: Date = new Date()): ZonedNow {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  const y = Number(get('year'))
  const m = Number(get('month'))
  const d = Number(get('day'))
  const hour = Number(get('hour')) === 24 ? 0 : Number(get('hour'))
  // ISO week of the local civil date.
  const probe = new Date(Date.UTC(y, m - 1, d))
  const day = probe.getUTCDay() || 7
  probe.setUTCDate(probe.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(probe.getUTCFullYear(), 0, 1))
  const week = Math.ceil(
    ((probe.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  )
  const isoWeek = `${probe.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const yearMonth = `${y}-${String(m).padStart(2, '0')}`
  return { hour, date, isoWeek, yearMonth }
}

function isDue(
  frequency: DigestFrequency,
  hourLocal: number,
  lastSentAt: Date | null,
  now: ZonedNow,
): boolean {
  if (now.hour !== hourLocal) return false
  if (!lastSentAt) return true
  const last = zonedNow(lastSentAt)
  if (frequency === 'daily') return last.date !== now.date
  if (frequency === 'weekly') return last.isoWeek !== now.isoWeek
  if (frequency === 'monthly') return last.yearMonth !== now.yearMonth
  return false
}

interface DigestRunResult {
  examined: number
  dispatched: number
  failed: number
  errors: Array<{ id: string; error: string }>
}

export async function runDigestTick(
  at: Date = new Date(),
): Promise<DigestRunResult> {
  const now = zonedNow(at)
  const result: DigestRunResult = {
    examined: 0,
    dispatched: 0,
    failed: 0,
    errors: [],
  }
  let rows: Array<{
    id: string
    email: string
    frequency: string
    hourLocal: number
    lastSentAt: Date | null
  }> = []
  try {
    rows = await prisma.scheduledReport.findMany({
      where: { isActive: true, hourLocal: now.hour },
      select: {
        id: true,
        email: true,
        frequency: true,
        hourLocal: true,
        lastSentAt: true,
      },
    })
  } catch (err) {
    logger.warn('digest cron: scheduled-reports table unavailable', {
      error: err instanceof Error ? err.message : String(err),
    })
    return result
  }
  result.examined = rows.length
  for (const r of rows) {
    const f = r.frequency as DigestFrequency
    if (f !== 'daily' && f !== 'weekly' && f !== 'monthly') continue
    if (!isDue(f, r.hourLocal, r.lastSentAt, now)) continue
    const recipients = r.email
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (recipients.length === 0) continue
    try {
      const send = await sendDigest({ recipients, frequency: f, now: at })
      if (!send.ok) {
        result.failed += 1
        result.errors.push({ id: r.id, error: send.error ?? 'unknown' })
        continue
      }
      result.dispatched += 1
      await prisma.scheduledReport.update({
        where: { id: r.id },
        data: { lastSentAt: at },
      })
    } catch (err) {
      result.failed += 1
      result.errors.push({
        id: r.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

export function startDashboardDigestCron(): void {
  if (scheduledTask) {
    logger.warn('digest cron already started — skipping')
    return
  }
  // Fire at minute 5 of every hour (gives upstream cron jobs at
  // minute 0 a small buffer to finish before the digest reads).
  const schedule =
    process.env.NEXUS_DASHBOARD_DIGEST_CRON_SCHEDULE ?? '5 * * * *'
  if (!cron.validate(schedule)) {
    logger.error('digest cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void (async () => {
      try {
        await recordCronRun('dashboard-digest', async () => {
          const r = await runDigestTick()
          return `examined=${r.examined} dispatched=${r.dispatched} failed=${r.failed}`
        })
      } catch (err) {
        logger.error('digest cron: top-level failure', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  })
  logger.info('digest cron: scheduled', { schedule })
}

export function stopDashboardDigestCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export const __test = { isDue, zonedNow, runDigestTick }
