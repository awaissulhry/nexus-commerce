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
import { updateCampaignWithSync, bulkUpdateAdTargetBids, type AdsActor } from '../services/advertising/ads-mutation.service.js'

// AU.3 — bid multiplier per window. A window can optionally carry a
// bidMultiplierPct (e.g. +30 to raise bids 30% during peak hours, -50 to
// cut them overnight). On window-enter we snapshot original bids + apply
// the multiplied bid; on window-exit we restore from the snapshot.
interface Window { days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number }

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
  if (!Array.isArray(windows) || windows.length === 0) return true
  const { day, hour } = nowInTz(tz)
  return windows.some((w) => {
    const days = w.days ?? [0, 1, 2, 3, 4, 5, 6]
    const start = w.startHour ?? 0
    const end = w.endHour ?? 24
    return days.includes(day) && hour >= start && hour < end
  })
}

/** The active window's bidMultiplierPct (first matching), or null if none. */
function activeMultiplier(windows: Window[], tz: string): number | null {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const { day, hour } = nowInTz(tz)
  for (const w of windows) {
    const days = w.days ?? [0, 1, 2, 3, 4, 5, 6]
    const start = w.startHour ?? 0
    const end = w.endHour ?? 24
    if (days.includes(day) && hour >= start && hour < end && w.bidMultiplierPct != null) {
      return w.bidMultiplierPct
    }
  }
  return null
}

export async function runDaypartingOnce(): Promise<{ evaluated: number; changed: number; bidsAdjusted: number }> {
  const schedules = await prisma.adSchedule.findMany({ where: { enabled: true } })
  let changed = 0
  let bidsAdjusted = 0
  for (const s of schedules) {
    const inWindow = shouldDeliver((s.windows as Window[]) ?? [], s.timezone)
    const desired = inWindow ? 'ENABLED' : 'PAUSED'
    const multiplier = activeMultiplier((s.windows as Window[]) ?? [], s.timezone)
    const campaign = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { status: true } })
    if (!campaign) continue

    // ── Status change (pause/resume) ─────────────────────────────────
    if (s.lastApplied !== desired && campaign.status !== 'ARCHIVED' && campaign.status !== desired) {
      try {
        await updateCampaignWithSync({ campaignId: s.campaignId, patch: { status: desired }, actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'dayparting window', applyImmediately: true } as never)
        changed++
      } catch (e) { logger.warn('[dayparting] status apply failed', { scheduleId: s.id, error: (e as Error).message }) }
    }

    // ── AU.3 bid multiplier ───────────────────────────────────────────
    const storedOriginals = (s.originalBids ?? {}) as Record<string, number>
    const hasStoredOriginals = Object.keys(storedOriginals).length > 0

    if (inWindow && multiplier != null && !hasStoredOriginals) {
      // Entering a bid-multiplier window: snapshot originals + apply scaled bids.
      const targets = await prisma.adTarget.findMany({
        where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId: s.campaignId } },
        select: { id: true, bidCents: true },
      })
      if (targets.length > 0) {
        const originals: Record<string, number> = {}
        const entries = targets.map((t) => {
          originals[t.id] = t.bidCents
          const scaled = Math.max(5, Math.round(t.bidCents * (1 + multiplier / 100)))
          return { adTargetId: t.id, bidCents: scaled }
        })
        try {
          await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${s.id}` as AdsActor, reason: `bid multiplier +${multiplier}%`, applyImmediately: true })
          await prisma.adSchedule.update({ where: { id: s.id }, data: { originalBids: originals } })
          bidsAdjusted += entries.length
          logger.info('[dayparting] bid multiplier applied', { scheduleId: s.id, multiplier, targets: entries.length })
        } catch (e) { logger.warn('[dayparting] bid multiply failed', { scheduleId: s.id, error: (e as Error).message }) }
      }
    } else if ((!inWindow || multiplier == null) && hasStoredOriginals) {
      // Exiting the bid-multiplier window: restore original bids.
      const entries = Object.entries(storedOriginals).map(([adTargetId, bidCents]) => ({ adTargetId, bidCents }))
      try {
        await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'bid multiplier restore', applyImmediately: true })
        await prisma.adSchedule.update({ where: { id: s.id }, data: { originalBids: {} } })
        bidsAdjusted += entries.length
        logger.info('[dayparting] bid multiplier restored', { scheduleId: s.id, targets: entries.length })
      } catch (e) { logger.warn('[dayparting] bid restore failed', { scheduleId: s.id, error: (e as Error).message }) }
    }

    await prisma.adSchedule.update({ where: { id: s.id }, data: { lastApplied: desired, lastEvaluatedAt: new Date() } })
  }
  logger.info('[dayparting] tick', { evaluated: schedules.length, changed, bidsAdjusted })
  return { evaluated: schedules.length, changed, bidsAdjusted }
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
