/**
 * BS — Budget Schedule cron. Every 15 min, for each enabled BudgetSchedule, decide the daily
 * budget each selected campaign SHOULD have right now: the active weekly window's adjustment
 * (Set €, Increase/Decrease %, or a daily ×multiplier) applied to the campaign's base budget,
 * clamped to Amazon's €1 floor. Outside every window (or outside the start/end/exclude dates)
 * the campaign is restored to its base budget. lastApplied (per campaign) avoids churn.
 * Sandbox-safe — the write path (updateCampaignWithSync) short-circuits in sandbox.
 */
import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { updateCampaignWithSync } from '../services/advertising/ads-mutation.service.js'

interface BSWindow { day?: number; start?: string; end?: string; adj?: string; value?: number }
interface BSCampaign { id: string; name?: string; dailyBudget?: number | null }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** Current weekday (0=Sun..6=Sat) + minutes-from-midnight in a timezone. */
function nowInTz(tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date())
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  const day = DOW.indexOf(wk)
  return { day: day < 0 ? 0 : day, minutes: (Number.isNaN(hour) ? 0 : hour) * 60 + (Number.isNaN(minute) ? 0 : minute) }
}
const parseHHMM = (s?: string): number => { if (!s) return 0; const [h, m] = s.split(':').map((x) => parseInt(x, 10)); return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m) }

/** The window active right now (matching weekday + time-of-day), or null. */
function activeWindow(windows: BSWindow[], tz: string): BSWindow | null {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const { day, minutes } = nowInTz(tz)
  return windows.find((w) => {
    const wDay = Number(w.day)
    if (!w.start || !w.end) return wDay === day // daily (multiplier) windows span the whole day
    const a = parseHHMM(w.start)
    const b = parseHHMM(w.end)
    /**
     * BSP.2 (§2.1) — a window whose end is at or before its start WRAPS past midnight.
     * `22:00 → 02:00` used to evaluate `minutes >= 1320 && minutes < 120` and was never active,
     * and hour 23 was unreachable by any window (TIME_OPTIONS ends at 23:00 and the match is
     * `< end`) — €97.73 = 5.7% of hourly-tracked spend, the account's fourth-largest hour.
     * With the wrap, `23:00 → 00:00` covers it. Two care points:
     *   · the post-midnight half runs under the FOLLOWING weekday, so it matches `(day+1) % 7`
     *     — the picker names the day the window STARTS;
     *   · `start === end` stays "never", the prior behaviour for a degenerate window, not
     *     silently repurposed as all-day.
     */
    if (a === b) return false
    if (a < b) return wDay === day && minutes >= a && minutes < b
    return (wDay === day && minutes >= a) || ((wDay + 1) % 7 === day && minutes < b)
  }) ?? null
}

/** Is "today" within the schedule's start/end window and outside every exclude range? */
function dateActive(s: { startDate: Date | null; endDate: Date | null; neverExpire: boolean; excludeDates: unknown }): boolean {
  const today = new Date(); today.setUTCHours(12, 0, 0, 0)
  if (s.startDate && today < new Date(new Date(s.startDate).setUTCHours(0, 0, 0, 0))) return false
  if (!s.neverExpire && s.endDate && today > new Date(new Date(s.endDate).setUTCHours(23, 59, 59, 0))) return false
  const ex = Array.isArray(s.excludeDates) ? s.excludeDates as Array<{ start?: string; end?: string }> : []
  for (const r of ex) { if (r.start && r.end && today >= new Date(r.start) && today <= new Date(r.end)) return false }
  return true
}

/** New daily budget for a window, clamped to Amazon's €1 floor. */
export function computeBudget(base: number, type: string, adj?: string, value?: number): number {
  const v = Number(value) || 0
  let next = base
  if (type === 'budget-multiplier') next = base * (v || 1)
  else if (adj === 'set') next = v
  else if (adj === 'incPct') next = base * (1 + v / 100)
  else if (adj === 'decPct') next = base * (1 - v / 100)
  return Math.max(1, Math.round(next * 100) / 100) // €1 Amazon minimum
}

export async function runBudgetScheduleOnce(): Promise<{ evaluated: number; changed: number }> {
  const schedules = await prisma.budgetSchedule.findMany({ where: { kind: 'BUDGET', enabled: true } })
  let changed = 0
  for (const s of schedules) {
    const windows = (s.windows as unknown as BSWindow[]) ?? []
    const camps = (s.campaigns as unknown as BSCampaign[]) ?? []
    const within = dateActive(s)
    const win = within ? activeWindow(windows, s.timezone) : null
    const last = (s.lastApplied as Record<string, { budget?: number }> | null) ?? {}
    const nextLast: Record<string, { budget: number; at: string }> = {}

    for (const c of camps) {
      const campaign = await prisma.campaign.findUnique({ where: { id: c.id }, select: { dailyBudget: true, status: true, budgetBaselineCents: true } })
      if (!campaign || campaign.status === 'ARCHIVED') continue
      /**
       * BSP.2 (§2.5) — the base, in precedence order:
       *   1. the operator's CAPTURED BASELINE (BUD.2's anchor — the one number every relative
       *      budget mechanism now agrees to return to);
       *   2. the creation-time snapshot (the old behaviour, for campaigns with no baseline);
       *   3. the live value, when the snapshot never carried one.
       * A schedule created before the August ratchet used to keep restoring pre-ratchet budgets
       * forever — undoing both the rules and the pacer — because the snapshot was frozen at
       * creation and nothing could refresh it.
       */
      const base = campaign.budgetBaselineCents != null
        ? campaign.budgetBaselineCents / 100
        : c.dailyBudget != null ? Number(c.dailyBudget) : Number(campaign.dailyBudget ?? 0)
      // In a window → the window's budget; otherwise restore base.
      const target = win ? computeBudget(base, s.type, win.adj, win.value) : Math.max(1, Math.round(base * 100) / 100)
      const live = Number(campaign.dailyBudget ?? 0)
      /**
       * BSP.2 (§2.4) — the guard order, rebuilt:
       *   · REALITY first: if the live budget already equals the target there is nothing to do,
       *     and that fact (not our intent) is what gets memoised.
       *   · The memo second: the one-shot stays a one-shot, in AND out of windows — two other
       *     engines write this same field (§3's measured oscillation), and whether this schedule
       *     should re-fight them is the §3 precedence decision, which is the operator's. This fix
       *     changes what the memo RECORDS, never who wins.
       *   · A FAILED write is no longer memoised as applied — the old code stamped `nextLast`
       *     before the attempt, so one failure silently skipped the window until the target
       *     changed. Now the previous memo carries forward and the next tick retries.
       */
      if (live === target) { nextLast[c.id] = { budget: target, at: new Date().toISOString() }; continue }
      if (last[c.id]?.budget === target) { nextLast[c.id] = { budget: target, at: new Date().toISOString() }; continue }
      try {
        await updateCampaignWithSync({ campaignId: c.id, patch: { dailyBudget: target }, actor: `automation:budget-schedule-${s.id}` as never, reason: win ? `budget schedule: window → €${target}` : 'budget schedule: outside window → base', applyImmediately: true } as never)
        changed++
        nextLast[c.id] = { budget: target, at: new Date().toISOString() }
        logger.info('[budget-schedule] applied', { scheduleId: s.id, campaignId: c.id, budget: target, inWindow: !!win })
      } catch (e) {
        // Carry the previous memo (if any) so the failure is retried, not laundered into success.
        if (last[c.id]?.budget != null) nextLast[c.id] = { budget: last[c.id].budget!, at: new Date().toISOString() }
        logger.warn('[budget-schedule] apply failed — will retry next tick', { scheduleId: s.id, campaignId: c.id, error: (e as Error).message })
      }
    }
    await prisma.budgetSchedule.update({ where: { id: s.id }, data: { lastApplied: nextLast, lastEvaluatedAt: new Date() } })
  }
  logger.info('[budget-schedule] tick', { evaluated: schedules.length, changed })
  return { evaluated: schedules.length, changed }
}

export async function runBudgetScheduleCron(): Promise<void> {
  try { await recordCronRun('ad-budget-schedule', async () => { const r = await runBudgetScheduleOnce(); return `evaluated=${r.evaluated} changed=${r.changed}` }) }
  catch (err) { logger.error('ad-budget-schedule cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false // overlap guard
export function startBudgetScheduleCron(): void {
  if (task) return
  task = cron.schedule('*/15 * * * *', () => {
    if (running) { logger.warn('[ad-budget-schedule] previous tick still in flight — skipping'); return }
    running = true
    void runBudgetScheduleCron().finally(() => { running = false })
  })
  logger.info('ad-budget-schedule cron scheduled (*/15 * * * *)')
}
