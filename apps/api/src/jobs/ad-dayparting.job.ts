/**
 * AX.9 — Dayparting cron. Every 15 min, for each enabled AdSchedule,
 * decide whether the campaign SHOULD be delivering right now (current
 * day×hour in the schedule's timezone falls inside an active window). If
 * the desired status differs from what we last applied, enqueue a
 * status change via the shipped write path (grace + audit + sync). Tracks
 * lastApplied to avoid churn. Sandbox-safe (writes short-circuit in sandbox).
 *
 * 1c — honours the account dial and its own caps (ads-engine-guard.ts): SUGGEST writes nothing new
 * but still lifts its own floors and multipliers; halted / OFF only floors bids, restores wait for
 * Resume; at most N changes a run and a day, one schedule's campaign never split.
 *
 * 2d (review 3.9) — it leaves alone what is not its own: the window-open restore lifts only a Rank &
 * Dayparting floor (2a's `isRankOwnedFloor`), the multiplier never enters, moves or leaves over a floor
 * (it would raise it), and leaving a multiplier window gives back only bids still at what the window set
 * (a person's in-window edit stays). Switching a schedule off or deleting it gives its multiplier back
 * (`giveBackMultiplier`).
 */

import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { bulkUpdateAdTargetBids, type AdsActor } from '../services/advertising/ads-mutation.service.js'
import { suppressCampaignBids, restoreCampaignBids } from '../services/advertising/ads-bid-suppression.service.js'
import { isGoalMode } from './ad-rank-defend.job.js'
import { allowChange, engineGuardNote, nothingHeld, openEngineGuard, readEnginePosture, type EngineGuard, type EngineGuardReport } from '../services/advertising/ads-engine-guard.js'
import { isRankOwnedFloor } from '../services/advertising/rank-release.service.js'
import { brainOwnedCampaignIds } from '../services/advertising/bid-brain/live.js'

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

// ── The multiplier snapshot (AdSchedule.originalBids) ─────────────────────────────────────────────────────────────
// { [adTargetId]: base bid, __mult__: the multiplier applied, __set__: { [adTargetId]: the bid the window set } }.
// 2d — `__set__` is read back after the write, so it holds what landed (a campaign's max-change clamp can trim it).
const MULT_KEY = '__mult__'
const SET_KEY = '__set__'
export interface MultiplierSnapshot { base: Record<string, number>; mult: number | null; set: Record<string, number> | null }

export function readSnapshot(stored: unknown): MultiplierSnapshot {
  const raw = (stored ?? {}) as Record<string, unknown>
  const base: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) if (k !== MULT_KEY && k !== SET_KEY && typeof v === 'number') base[k] = v
  const mult = typeof raw[MULT_KEY] === 'number' ? raw[MULT_KEY] as number : null
  const set = raw[SET_KEY] && typeof raw[SET_KEY] === 'object' ? raw[SET_KEY] as Record<string, number> : null
  return { base, mult, set }
}

const scaled = (base: number, mult: number) => Math.max(5, Math.round(base * (1 + mult / 100)))

/**
 * 2d — the snapshot's targets the window still owns: those whose bid now (for a floored campaign, the bid its floor
 * remembers) is still what the window set. A bid that moved since is a person's (or another engine's) and stays.
 * A snapshot from before `__set__` falls back to the multiplied base; one with neither owns every target, as before.
 */
export function ownedTargets(snap: MultiplierSnapshot, now: Map<string, number | null>): string[] {
  return Object.keys(snap.base).filter((id) => {
    const want = snap.set?.[id] ?? (snap.mult != null ? scaled(snap.base[id], snap.mult) : null)
    return now.get(id) != null && (want == null || now.get(id) === want)
  })
}

/** Each target's bid now, or (`remembered`) the bid its floor will restore. */
async function bidsNow(ids: string[], remembered: boolean): Promise<Map<string, number | null>> {
  const rows = ids.length ? await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, bidCents: true, suppressedFromBidCents: true } }) : []
  return new Map(rows.map((r) => [r.id, remembered ? r.suppressedFromBidCents : r.bidCents]))
}

/** Apply `mult` to each base bid, then keep the snapshot: the base, the multiplier and the bids that landed. */
async function applyMultiplier(scheduleId: string, base: Record<string, number>, mult: number, reason: string): Promise<number> {
  const entries = Object.entries(base).map(([adTargetId, b]) => ({ adTargetId, bidCents: scaled(b, mult) }))
  await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${scheduleId}` as AdsActor, reason, applyImmediately: true })
  const landed = await bidsNow(Object.keys(base), false)
  const set: Record<string, number> = {}
  for (const id of Object.keys(base)) { const b = landed.get(id); if (b != null) set[id] = b }
  await prisma.adSchedule.update({ where: { id: scheduleId }, data: { originalBids: { [MULT_KEY]: mult, ...base, [SET_KEY]: set } } })
  return entries.length
}

/**
 * Leave a multiplier: the targets the window still owns go back to their base. On a floored campaign (any owner) the
 * base goes into the floor's memory instead — Nexus only, nothing to Amazon, which keeps the floor — so whoever lifts
 * it returns to the base. Returns the bids written to Amazon, or null when it must wait (`mayWrite` false and not
 * floored). The snapshot is cleared once done.
 */
async function leaveMultiplier(s: { id: string; campaignId: string }, snap: MultiplierSnapshot, floored: boolean, mayWrite: boolean, reason: string): Promise<number | null> {
  const ids = Object.keys(snap.base)
  if (floored) {
    const owned = ownedTargets(snap, await bidsNow(ids, true))
    for (const adTargetId of owned) {
      await prisma.adTarget.updateMany({ where: { id: adTargetId, suppressedFromBidCents: { not: null } }, data: { suppressedFromBidCents: snap.base[adTargetId] } })
    }
    await prisma.adSchedule.updateMany({ where: { id: s.id }, data: { originalBids: {} } })
    logger.info('[dayparting] bid multiplier left while floored — restore will return to the base bids', { scheduleId: s.id, targets: owned.length, keptChangedInWindow: ids.length - owned.length })
    return 0
  }
  if (!mayWrite) return null
  const entries = ownedTargets(snap, await bidsNow(ids, false)).map((adTargetId) => ({ adTargetId, bidCents: snap.base[adTargetId] }))
  if (entries.length) await bulkUpdateAdTargetBids({ entries, actor: `automation:dayparting-${s.id}` as AdsActor, reason, applyImmediately: true })
  await prisma.adSchedule.updateMany({ where: { id: s.id }, data: { originalBids: {} } })
  logger.info('[dayparting] bid multiplier restored', { scheduleId: s.id, targets: entries.length, keptChangedInWindow: ids.length - entries.length })
  return entries.length
}

const isFloored = async (campaignId: string) =>
  !!(await prisma.campaign.findUnique({ where: { id: campaignId }, select: { bidsSuppressedAt: true } }))?.bidsSuppressedAt

export interface MultiplierGiveBack { restored: number; deferred: boolean; why: string | null }

/**
 * 2d (review 3.9; left open by 2a) — a classic schedule switched off or deleted gives its bid multiplier back: the bids
 * still at the window's level return to their base, a bid a person changed in the window stays. While ads automation
 * is stopped the change would be refused, so it waits (`deferred`) and the snapshot stays: a switched-off schedule
 * keeps it on its row and the next run that may write gives it back (`runDaypartingOnce`). `guard` = the run's.
 */
export async function giveBackMultiplier(s: { id: string; campaignId: string; originalBids: unknown }, reason: string, guard?: EngineGuard): Promise<MultiplierGiveBack> {
  const snap = readSnapshot(s.originalBids)
  if (!Object.keys(snap.base).length) return { restored: 0, deferred: false, why: null }
  const g = guard ?? await openEngineGuard('dayparting')
  const permit = g.permit()
  const held = nothingHeld()
  let restored: number | null = 0
  try {
    const floored = await isFloored(s.campaignId)
    restored = await leaveMultiplier(s, snap, floored, !floored && allowChange(true, permit, held, 'restore'), reason)
  } catch (e) { logger.warn('[dayparting] multiplier give-back failed — kept for the next run', { scheduleId: s.id, error: (e as Error).message }); restored = null }
  g.settle(permit, restored ?? 0, held)
  return restored == null
    ? { restored: 0, deferred: true, why: held.restore ? `ads automation is stopped (${g.report().why})` : 'the give-back did not finish; the next run retries' }
    : { restored, deferred: false, why: null }
}

/** Why a multiplier give-back would wait right now (null = it would run): applied, campaign not floored, stopped. */
export async function multiplierWaitWhy(s: { campaignId: string; originalBids: unknown }): Promise<string | null> {
  if (!Object.keys(readSnapshot(s.originalBids).base).length || await isFloored(s.campaignId)) return null
  const { posture, why } = await readEnginePosture()
  return posture === 'stopped' ? `ads automation is stopped (${why})` : null
}

// BB-6 — `brainOwned`: classic schedules on a campaign the bid brain owns, left to the brain (one writer per campaign).
export interface DaypartingSummary { evaluated: number; changed: number; bidsAdjusted: number; guard?: EngineGuardReport; brainOwned?: number }

export async function runDaypartingOnce(): Promise<DaypartingSummary> {
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

  const classic = (await prisma.adSchedule.findMany({ where: { enabled: true } }))
    .filter((s) => !isGoalMode(s.windows, s.defaultTargetKey) && !planGoverned.has(s.campaignId))
  // BID BRAIN BB-6 — a campaign the brain owns has one writer, the brain: its classic schedule is left alone.
  const brainOwned = await brainOwnedCampaignIds(classic.map((s) => s.campaignId))
  const schedules = classic.filter((s) => !brainOwned.has(s.campaignId))
  // 2d — classic schedules switched off while their multiplier was on, whose give-back had to wait (ads automation was
  // stopped): each row keeps its snapshot, and the first run that may write gives the bids back.
  const parked = (await prisma.adSchedule.findMany({ where: { enabled: false }, select: { id: true, campaignId: true, windows: true, defaultTargetKey: true, originalBids: true } }))
    .filter((s) => !isGoalMode(s.windows, s.defaultTargetKey) && Object.keys(readSnapshot(s.originalBids).base).length > 0)
  // Authoritative clock (DB) for all window checks this run — immune to container clock skew.
  const clockNow = await dbNow()
  let changed = 0
  let bidsAdjusted = 0
  // 1c — the account dial and this engine's caps, read once per run. Each schedule's campaign asks for its permit
  // once, before its first write, so a campaign is never split.
  const guard = schedules.length || parked.length ? await openEngineGuard('dayparting') : null
  for (const s of schedules) {
    const inWindow = shouldDeliver((s.windows as Window[]) ?? [], s.timezone, clockNow)
    const desired = inWindow ? 'ENABLED' : 'PAUSED'
    const multiplier = activeMultiplier((s.windows as Window[]) ?? [], s.timezone, clockNow)
    const campaign = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { status: true, bidsSuppressedAt: true, bidsSuppressedBy: true, marketplace: true } })
    if (!campaign) continue
    // W1-6 — the campaign's market: that market's own "most actions per run" (the ads strategy) counts its changes too.
    const permit = guard!.permit({ market: campaign.marketplace })
    const held = nothingHeld()
    const allow = (kind: 'forward' | 'floor' | 'restore') => allowChange(true, permit, held, kind)
    let writes = 0
    let floored = !!campaign.bidsSuppressedAt

    // ── NP — never pause (Amazon algo disruption). Window OPEN: lift any no-pause
    // floor BEFORE the multiplier logic reads current bids, so 'enter' snapshots the
    // true base, not the 2¢ floor. ──
    // 1c — a give-back: never capped; while stopped it waits (the gate would refuse the raise after Nexus restored).
    // 2d — only a Rank & Dayparting floor (2a's owner rule): a person's, the out-of-stock check's or budget enforcement's
    // floor stays until its owner lifts it.
    if (inWindow && floored && isRankOwnedFloor(campaign.bidsSuppressedBy) && allow('restore')) {
      try { writes += await restoreCampaignBids(s.campaignId, { actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'dayparting: window open → restore bids' }); changed++ } catch (e) { logger.warn('[dayparting] restore failed', { scheduleId: s.id, error: (e as Error).message }) }
      floored = await isFloored(s.campaignId)
    }

    // ── AU.3 / RC2.TR0 bid multiplier (enter / transition / exit) ───────
    // originalBids holds the TRUE base bids snapshotted on entry, plus a reserved
    // __mult__ key = the multiplier currently applied. Tracking the applied level
    // lets us re-apply from base when moving between two DIFFERENT multiplier
    // windows on the same day (e.g. +0% morning → +50% evening) — without it the
    // bids stuck at the first level. (The snapshot's shape: `readSnapshot`.)
    const snap = readSnapshot(s.originalBids)
    // 2d — a multiplier is on while `__mult__` is set, even when every bid in it has become a person's (a transition
    // dropped them all): otherwise the next run would enter again and scale the bids they set.
    const hasBase = Object.keys(snap.base).length > 0 || snap.mult != null
    // 0 / undefined multiplier behaves like "no adjustment".
    const effMult = (multiplier == null || multiplier === 0) ? null : multiplier
    const action = bidAction({ inWindow, effMult, hasBase, appliedMult: snap.mult })

    // 1c — entering or moving between multiplier windows is a new change (capped; withheld under SUGGEST and while
    // stopped, where the gate would refuse it after Nexus changed its bids); leaving one gives its own change back.
    // 2d — never over a floor (anyone's, or its own while that restore waits): entering would snapshot the floor as the
    // base, and entering or moving would raise floored bids. Both wait until the floor is lifted.
    if (action === 'enter' && !floored) {
      // ENTER a multiplier window: snapshot base bids + apply scaled.
      // W1-6b — not the targets of an ad group floored on its own (a product over its cap): scaling them would lift it.
      const targets = await prisma.adTarget.findMany({
        where: { status: 'ENABLED', isNegative: false, adGroup: { campaignId: s.campaignId, bidsSuppressedAt: null } },
        select: { id: true, bidCents: true },
      })
      if (targets.length > 0 && allow('forward')) {
        try {
          const n = await applyMultiplier(s.id, Object.fromEntries(targets.map((t) => [t.id, t.bidCents])), effMult, `bid multiplier ${effMult >= 0 ? '+' : ''}${effMult}%`)
          bidsAdjusted += n; writes += n
          logger.info('[dayparting] bid multiplier applied', { scheduleId: s.id, multiplier: effMult, targets: n })
        } catch (e) { logger.warn('[dayparting] bid multiply failed', { scheduleId: s.id, error: (e as Error).message }) }
      }
    } else if (action === 'transition' && !floored && allow('forward')) {
      // TRANSITION between two multiplier windows: re-apply from base at new level. 2d — only to the bids the window
      // still owns; a bid a person changed in the window leaves the snapshot and stays as they set it.
      const owned = ownedTargets(snap, await bidsNow(Object.keys(snap.base), false))
      try {
        const n = await applyMultiplier(s.id, Object.fromEntries(owned.map((id) => [id, snap.base[id]])), effMult, `bid multiplier ${effMult >= 0 ? '+' : ''}${effMult}% (transition)`)
        bidsAdjusted += n; writes += n
        logger.info('[dayparting] bid multiplier transitioned', { scheduleId: s.id, from: snap.mult, to: effMult, targets: n })
      } catch (e) { logger.warn('[dayparting] bid transition failed', { scheduleId: s.id, error: (e as Error).message }) }
    } else if (action === 'exit') {
      // EXIT: restore base bids — 2d: only those still at what the window set. 1c — already floored (the floor landed
      // while this exit waited, or someone else floored it): pushing the base now would lift the floor, so the base
      // becomes what the restore returns to instead (Nexus only; `leaveMultiplier`).
      try {
        const n = await leaveMultiplier(s, snap, floored, !floored && allow('restore'), 'bid multiplier restore')
        if (n) { bidsAdjusted += n; writes += n }
      } catch (e) { logger.warn('[dayparting] bid restore failed', { scheduleId: s.id, error: (e as Error).message }) }
    }

    // ── NP — window CLOSED: floor bids instead of pausing. The 'exit' branch above
    // has already restored base bids, so we snapshot + floor the true base. ──
    // 1c — a floor: the one new change allowed while stopped; capped like any other. If the exit above was held
    // (stopped), this floor remembers the multiplied bids; the next run's exit moves the base into that memory.
    if (!inWindow && !campaign.bidsSuppressedAt && allow('floor')) {
      try { writes += await suppressCampaignBids(s.campaignId, { actor: `automation:dayparting-${s.id}` as AdsActor, reason: 'dayparting: window closed → bids floored (no-pause)' }); changed++ } catch (e) { logger.warn('[dayparting] suppress failed', { scheduleId: s.id, error: (e as Error).message }) }
    }
    guard!.settle(permit, writes, held)
    // SYNC.1 — a PAUSED campaign is left PAUSED. Twin of the block removed from ad-rank-defend:
    // it re-enabled any paused campaign under a schedule and pushed that to Amazon, which meant an
    // operator pausing in Seller Central was overridden within a tick. Worse here than there — it
    // sat outside the `inWindow` check, so it resumed a campaign even while the window was CLOSED
    // and this job had just floored its bids. Dayparting expresses "off" as a bid floor (the
    // suppress call above); campaign state is not its lever.

    await prisma.adSchedule.update({ where: { id: s.id }, data: { lastApplied: desired, lastEvaluatedAt: new Date() } })
  }
  for (const s of parked) {
    const r = await giveBackMultiplier(s, 'bid multiplier given back — its schedule is switched off', guard!)
    if (r.restored) { changed++; bidsAdjusted += r.restored }
  }
  logger.info('[dayparting] tick', { evaluated: schedules.length, changed, bidsAdjusted })
  return { evaluated: schedules.length, changed, bidsAdjusted, ...(guard ? { guard: guard.report() } : {}), ...(brainOwned.size ? { brainOwned: brainOwned.size } : {}) }
}

/** 1c — the run's summary line: the counts, plus what the dial or the caps held back (nothing extra on a normal run). */
export function daypartingSummaryLine(r: DaypartingSummary): string {
  return `evaluated=${r.evaluated} changed=${r.changed}${engineGuardNote(r.guard)}${r.brainOwned ? ` brain-owned=${r.brainOwned} (the bid brain runs them)` : ''}`
}

export async function runDaypartingCron(): Promise<void> {
  try { await recordCronRun('ad-dayparting', async () => daypartingSummaryLine(await runDaypartingOnce())) }
  catch (err) { logger.error('ad-dayparting cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false // C3 — overlap guard: a slow tick must not run concurrently with the next
export function startDaypartingCron(): void {
  if (task) return
  task = cron.schedule('*/15 * * * *', async () => {
    if (running) { await logger.warn('[ad-dayparting] previous tick still in flight — skipping this run'); return }
    running = true
    await runDaypartingCron().finally(() => { running = false })
  })
  logger.info('ad-dayparting cron scheduled (*/15 * * * *)')
}
