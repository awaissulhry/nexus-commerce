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
import { suppressCampaignBids, restoreCampaignBids } from '../services/advertising/ads-bid-suppression.service.js'
import { isGoalMode } from './ad-rank-defend.job.js'

// AU.3 — bid multiplier per window. A window can optionally carry a
// bidMultiplierPct (e.g. +30 to raise bids 30% during peak hours, -50 to
// cut them overnight). On window-enter we snapshot original bids + apply
// the multiplied bid; on window-exit we restore from the snapshot.
interface Window { days?: number[]; startHour?: number; endHour?: number; bidMultiplierPct?: number }

// Clock source: the DATABASE clock, not the container process clock — Railway cron containers have
// exhibited multi-hour clock skew that silently shifted every dayparting window. Sourcing "now" from
// Postgres makes window selection immune to container clock drift.
async function dbNow(): Promise<Date> {
  try {
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
    const n = rows?.[0]?.now
    if (n instanceof Date) return n
    if (n) return new Date(n as unknown as string)
  } catch { /* fall through to process clock */ }
  return new Date()
}

/** Current weekday (0=Sun..6=Sat) + hour (0-23) in a timezone. baseNow: authoritative clock (dbNow()). */
function nowInTz(tz: string, baseNow?: Date): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(baseNow ?? new Date())
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0'
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  let hour = parseInt(hourStr, 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: dayIdx < 0 ? 0 : dayIdx, hour }
}

function shouldDeliver(windows: Window[], tz: string, baseNow?: Date): boolean {
  if (!Array.isArray(windows) || windows.length === 0) return true
  const { day, hour } = nowInTz(tz, baseNow)
  return windows.some((w) => {
    const days = w.days ?? [0, 1, 2, 3, 4, 5, 6]
    const start = w.startHour ?? 0
    const end = w.endHour ?? 24
    return days.includes(day) && hour >= start && hour < end
  })
}

/** The active window's bidMultiplierPct (first matching), or null if none. */
function activeMultiplier(windows: Window[], tz: string, baseNow?: Date): number | null {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const { day, hour } = nowInTz(tz, baseNow)
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

export type BidAction = 'enter' | 'transition' | 'exit' | 'none'
/**
 * RC2.TR0 — pure decision for the per-window bid multiplier (regression-tested).
 * enter: first time into a multiplier window (no base snapshot yet).
 * transition: already adjusted, but the active window's multiplier changed.
 * exit: was adjusted, now out of any multiplier window → restore base.
 */
export function bidAction(o: { inWindow: boolean; effMult: number | null; hasBase: boolean; appliedMult: number | null }): BidAction {
  if (o.inWindow && o.effMult != null && !o.hasBase) return 'enter'
  if (o.inWindow && o.effMult != null && o.hasBase && o.appliedMult !== o.effMult) return 'transition'
  if ((!o.inWindow || o.effMult == null) && o.hasBase) return 'exit'
  return 'none'
}

export async function runDaypartingOnce(): Promise<{ evaluated: number; changed: number; bidsAdjusted: number }> {
  // Goal-mode schedules (a baseline/window rank target) are owned by the
  // rank-defend loop — it sets placement bias + keeps the campaign serving.
  // Dayparting must skip them or the two crons fight (one pauses, one pushes).
  // The legacy windows stay intact but inert; drop defaultTargetKey to hand
  // control back to dayparting.
  // C3b — also skip campaigns governed by an enabled rank PLAN. A plan resolves its family
  // dynamically, so a plain (non-goal-mode) schedule sitting on a plan-governed campaign would
  // let dayparting floor/restore bids the rank plan is simultaneously holding — they'd fight.
  const planGoverned = new Set<string>()
  try {
    const plans = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { productId: true, marketplace: true, excludeCampaignIds: true } })
    if (plans.length) {
      const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
      for (const p of plans) {
        try {
          const fam = await resolveProductFamily({ parentProductId: p.productId, marketplace: p.marketplace })
          const excluded = new Set<string>(Array.isArray(p.excludeCampaignIds) ? (p.excludeCampaignIds as string[]) : [])
          for (const c of fam.campaigns ?? []) if (!excluded.has(c.id)) planGoverned.add(c.id)
        } catch { /* best-effort per plan */ }
      }
    }
  } catch { /* best-effort */ }

  const schedules = (await prisma.adSchedule.findMany({ where: { enabled: true } }))
    .filter((s) => !isGoalMode(s.windows, s.defaultTargetKey) && !planGoverned.has(s.campaignId))
  // Authoritative clock (DB) for all window checks this run — immune to container clock skew.
  const clockNow = await dbNow()
  let changed = 0
  let bidsAdjusted = 0
  for (const s of schedules) {
    const inWindow = shouldDeliver((s.windows as Window[]) ?? [], s.timezone, clockNow)
    const desired = inWindow ? 'ENABLED' : 'PAUSED'
    const multiplier = activeMultiplier((s.windows as Window[]) ?? [], s.timezone, clockNow)
    const campaign = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { status: true, bidsSuppressedAt: true } })
    if (!campaign) continue

    // ── NP — never pause (Amazon algo disruption). Window OPEN: lift any no-pause
    // floor BEFORE the multiplier logic reads current bids, so 'enter' snapshots the
    // true base, not the 2¢ floor. ──
    if (inWindow && campaign.bidsSuppressedAt) {
      try { await restoreCampaignBids(s.campaignId, { actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'dayparting: window open → restore bids' }); changed++ } catch (e) { logger.warn('[dayparting] restore failed', { scheduleId: s.id, error: (e as Error).message }) }
    }

    // ── AU.3 / RC2.TR0 bid multiplier (enter / transition / exit) ───────
    // originalBids holds the TRUE base bids snapshotted on entry, plus a reserved
    // __mult__ key = the multiplier currently applied. Tracking the applied level
    // lets us re-apply from base when moving between two DIFFERENT multiplier
    // windows on the same day (e.g. +0% morning → +50% evening) — without it the
    // bids stuck at the first level. (originalBids is touched only here.)
    const MULT_KEY = '__mult__'
    const stored = (s.originalBids ?? {}) as Record<string, number>
    const appliedMult = MULT_KEY in stored ? stored[MULT_KEY] : null
    const baseBids: Record<string, number> = {}
    for (const [k, v] of Object.entries(stored)) if (k !== MULT_KEY) baseBids[k] = v
    const hasBase = Object.keys(baseBids).length > 0
    // 0 / undefined multiplier behaves like "no adjustment".
    const effMult = (multiplier == null || multiplier === 0) ? null : multiplier
    const action = bidAction({ inWindow, effMult, hasBase, appliedMult })

    if (action === 'enter') {
      // ENTER a multiplier window: snapshot base bids + apply scaled.
      const targets = await prisma.adTarget.findMany({
        where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId: s.campaignId } },
        select: { id: true, bidCents: true },
      })
      if (targets.length > 0) {
        const originals: Record<string, number> = { [MULT_KEY]: effMult }
        const entries = targets.map((t) => {
          originals[t.id] = t.bidCents
          return { adTargetId: t.id, bidCents: Math.max(5, Math.round(t.bidCents * (1 + effMult / 100))) }
        })
        try {
          await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${s.id}` as AdsActor, reason: `bid multiplier ${effMult >= 0 ? '+' : ''}${effMult}%`, applyImmediately: true })
          await prisma.adSchedule.update({ where: { id: s.id }, data: { originalBids: originals } })
          bidsAdjusted += entries.length
          logger.info('[dayparting] bid multiplier applied', { scheduleId: s.id, multiplier: effMult, targets: entries.length })
        } catch (e) { logger.warn('[dayparting] bid multiply failed', { scheduleId: s.id, error: (e as Error).message }) }
      }
    } else if (action === 'transition') {
      // TRANSITION between two multiplier windows: re-apply from base at new level.
      const entries = Object.entries(baseBids).map(([adTargetId, base]) => ({ adTargetId, bidCents: Math.max(5, Math.round(base * (1 + effMult / 100))) }))
      try {
        await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${s.id}` as AdsActor, reason: `bid multiplier ${effMult >= 0 ? '+' : ''}${effMult}% (transition)`, applyImmediately: true })
        await prisma.adSchedule.update({ where: { id: s.id }, data: { originalBids: { [MULT_KEY]: effMult, ...baseBids } } })
        bidsAdjusted += entries.length
        logger.info('[dayparting] bid multiplier transitioned', { scheduleId: s.id, from: appliedMult, to: effMult, targets: entries.length })
      } catch (e) { logger.warn('[dayparting] bid transition failed', { scheduleId: s.id, error: (e as Error).message }) }
    } else if (action === 'exit') {
      // EXIT: restore base bids.
      const entries = Object.entries(baseBids).map(([adTargetId, bidCents]) => ({ adTargetId, bidCents }))
      try {
        await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'bid multiplier restore', applyImmediately: true })
        await prisma.adSchedule.update({ where: { id: s.id }, data: { originalBids: {} } })
        bidsAdjusted += entries.length
        logger.info('[dayparting] bid multiplier restored', { scheduleId: s.id, targets: entries.length })
      } catch (e) { logger.warn('[dayparting] bid restore failed', { scheduleId: s.id, error: (e as Error).message }) }
    }

    // ── NP — window CLOSED: floor bids instead of pausing. The 'exit' branch above
    // has already restored base bids, so we snapshot + floor the true base. ──
    if (!inWindow && !campaign.bidsSuppressedAt) {
      try { await suppressCampaignBids(s.campaignId, { actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'dayparting: window closed → bids floored (no-pause)' }); changed++ } catch (e) { logger.warn('[dayparting] suppress failed', { scheduleId: s.id, error: (e as Error).message }) }
    }
    // Resume only if something ELSE left it paused (we never pause). Never touch ARCHIVED.
    if (campaign.status === 'PAUSED') {
      try { await updateCampaignWithSync({ campaignId: s.campaignId, patch: { status: 'ENABLED' }, actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'dayparting: no-pause policy — resume', applyImmediately: true } as never); changed++ } catch (e) { logger.warn('[dayparting] resume failed', { scheduleId: s.id, error: (e as Error).message }) }
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
let running = false // C3 — overlap guard: a slow tick must not run concurrently with the next
export function startDaypartingCron(): void {
  if (task) return
  task = cron.schedule('*/15 * * * *', () => {
    if (running) { logger.warn('[ad-dayparting] previous tick still in flight — skipping this run'); return }
    running = true
    void runDaypartingCron().finally(() => { running = false })
  })
  logger.info('ad-dayparting cron scheduled (*/15 * * * *)')
}
