/**
 * AX.9 — Dayparting cron. Every 15 min, for each enabled AdSchedule,
 * decide whether the campaign SHOULD be delivering right now (current
 * day×hour in the schedule's timezone falls inside an active window). If
 * the desired status differs from what we last applied, enqueue a
 * status change via the shipped write path (grace + audit + sync). Tracks
 * lastApplied to avoid churn. Sandbox-safe (writes short-circuit in sandbox).
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { updateCampaignWithSync } from '../services/advertising/ads-mutation.service.js'

interface Window { days?: number[]; startHour?: number; endHour?: number }

/** Current weekday (0=Sun..6=Sat) + hour (0-23) in a timezone. */
function nowInTz(tz: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date())
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0'
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  let hour = parseInt(hourStr, 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: dayIdx < 0 ? 0 : dayIdx, hour }
}

function shouldDeliver(windows: Window[], tz: string): boolean {
  if (!Array.isArray(windows) || windows.length === 0) return true // no windows = always on
  const { day, hour } = nowInTz(tz)
  return windows.some((w) => {
    const days = w.days ?? [0, 1, 2, 3, 4, 5, 6]
    const start = w.startHour ?? 0
    const end = w.endHour ?? 24
    return days.includes(day) && hour >= start && hour < end
  })
}

export async function runDaypartingOnce(): Promise<{ evaluated: number; changed: number }> {
  const schedules = await prisma.adSchedule.findMany({ where: { enabled: true } })
  let changed = 0
  for (const s of schedules) {
    const desired = shouldDeliver((s.windows as Window[]) ?? [], s.timezone) ? 'ENABLED' : 'PAUSED'
    if (s.lastApplied === desired) {
      await prisma.adSchedule.update({ where: { id: s.id }, data: { lastEvaluatedAt: new Date() } })
      continue
    }
    const campaign = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { status: true } })
    if (!campaign) continue
    // Only flip if the campaign isn't ARCHIVED and actually differs.
    if (campaign.status !== 'ARCHIVED' && campaign.status !== desired) {
      try {
        await updateCampaignWithSync({ campaignId: s.campaignId, patch: { status: desired }, actor: `dayparting:${s.id}`, reason: `dayparting window`, applyImmediately: true } as never)
        changed++
      } catch (e) { logger.warn('[AX.9] dayparting apply failed', { scheduleId: s.id, error: (e as Error).message }) }
    }
    await prisma.adSchedule.update({ where: { id: s.id }, data: { lastApplied: desired, lastEvaluatedAt: new Date() } })
  }
  logger.info('[AX.9] dayparting tick', { evaluated: schedules.length, changed })
  return { evaluated: schedules.length, changed }
}

export async function runDaypartingCron(): Promise<void> {
  try { await recordCronRun('ad-dayparting', async () => { const r = await runDaypartingOnce(); return `evaluated=${r.evaluated} changed=${r.changed}` }) }
  catch (err) { logger.error('ad-dayparting cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startDaypartingCron(): void {
  if (task) return
  task = cron.schedule('*/15 * * * *', () => void runDaypartingCron())
  logger.info('ad-dayparting cron scheduled (*/15 * * * *)')
}
