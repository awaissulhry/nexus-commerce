/**
 * BS — Budget Schedule cron. Every 15 min, for each enabled BudgetSchedule, decide the daily
 * budget each selected campaign SHOULD have right now: the active weekly window's adjustment
 * (Set €, Increase/Decrease %, or a daily ×multiplier) applied to the campaign's base budget,
 * clamped to Amazon's €1 floor.
 * Sandbox-safe — the write path (updateCampaignWithSync) short-circuits in sandbox.
 *
 * ── 🔴 THE PRECEDENCE RULE (BSP.6, operator-approved 2026-08-22) ───────────────────────────────
 *
 * **A schedule owns a campaign only while its own window is open. It writes ONCE per window entry.
 * When the window closes it gives the budget back exactly once, and then leaves the campaign
 * alone. If another writer moves a budget mid-window, the schedule stands down for the rest of
 * that entry and RECORDS WHO.**
 *
 * Three things follow, and each is a change from what this file did before:
 *
 * 1. **`windowKey`, not the target value, is the memo.** The old guard was
 *    `last.budget === target → skip`. It behaved like "once per window" only because the
 *    end-of-window restore happened to reset it; any day that restore was blocked, the next day's
 *    window silently did nothing. See `BSApplied` below.
 * 2. **Outside a window with nothing owed, the schedule does not write at all.** It used to assert
 *    `base` on every tick, which moved budgets before a new schedule's first window had ever
 *    opened and re-fought the pacer forever over campaigns it was not even boosting.
 * 3. **Yielding is attributed.** `overriddenBy` names the pacer, a rule (by name), or the operator.
 *
 * Why yield rather than re-fight: `AdBudgetPlan` (€4,000/month) is the authority over how much
 * money exists; a schedule is a shape within it. And mechanically, `budget_day_move` caps
 * cumulative daily movement across every writer at −30%/+50%-or-€10, so an oscillation would spend
 * that allowance in a few ticks and then block both engines for the rest of the day.
 *
 * The delete/disable give-back (`restoreBudgetScheduleBase`, ads-budget-schedule.service.ts) is a
 * SEPARATE mechanism — it runs when the operator removes the schedule — but since 3b it makes the
 * same "is it still ours?" check (`giveBackCheck`).
 *
 * 1d — honours the account dial and its own caps (ads-engine-guard.ts): SUGGEST enters no window but
 * still gives back a budget it set; halted / OFF writes nothing, give-backs wait for Resume; at most N
 * changes a run and a day. A held-back entry is not committed, so it is entered once allowed.
 *
 * 3b — what a give-back puts back, and when (review 6.2, 6.3, 6.6; the decision is `decideCampaign`):
 *   · the base is the budget just before the window opened — not the creation-time snapshot and not
 *     the rules' captured baseline (Owner S14). If the campaign still sits at the value this schedule
 *     set (back-to-back windows, a give-back that has not landed), the base it recorded before stands;
 *   · the give-back is written only while the campaign still sits at the value this schedule set.
 *     Anyone else's change made meanwhile wins: `yielded`, and nothing is written;
 *   · the record is kept outside windows, so the screen can still say what became of the give-back;
 *   · a give-back that did not reach Amazon is tried again once an hour while the campaign still sits
 *     at this schedule's value, at most GIVE_BACK_RETRIES times; then it shows as refused.
 * Every give-back carries `giveBackOf` evidence; the write gate recognises it from the action log
 * (ads-budget-giveback.ts, 3a) and exempts it from the day-move bound only.
 */
import cron from '../lib/cron/clustered.js'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { updateCampaignWithSync } from '../services/advertising/ads-mutation.service.js'
import { allowChange, engineGuardNote, nothingHeld, openEngineGuard, type EngineGuardReport } from '../services/advertising/ads-engine-guard.js'
import { leverHeldNote, readLeverHolds, type LeverHeld } from '../services/advertising/brain/engine-skips.js'
import { budgetDayKey, budgetDayStart } from '@nexus/shared/ads-budget-day'
import { parseDecimalInput } from '@nexus/shared/ads-number'

interface BSWindow { day?: number; start?: string; end?: string; adj?: string; value?: number }
interface BSCampaign { id: string; name?: string; dailyBudget?: number | null }

/** BSP.6 — the matched window plus the identity of THIS entry of it. */
export interface ActiveWindow { win: BSWindow; entryDate: string; key: string }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/**
 * Current weekday (0=Sun..6=Sat), minutes-from-midnight, and the CALENDAR DATE — all three in the
 * schedule's own timezone.
 *
 * BSP.6 — the date is new and it must come from here, not from `new Date()`. The window boundaries
 * are stated in this timezone, so the day a window belongs to has to be counted in the same
 * calendar; a UTC or server-local date would put a 23:00 Rome window on the wrong day for two hours
 * every night. [[reference_day_grouping_utc_local_trap]]
 */
function nowInTz(tz: string, now: Date = new Date()): { day: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const wk = get('weekday') || 'Sun'
  const hour = parseInt(get('hour') || '0', 10) % 24
  const minute = parseInt(get('minute') || '0', 10)
  const day = DOW.indexOf(wk)
  return {
    day: day < 0 ? 0 : day,
    minutes: (Number.isNaN(hour) ? 0 : hour) * 60 + (Number.isNaN(minute) ? 0 : minute),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/** The calendar day before an ISO date, by plain calendar arithmetic — DST-immune, unlike
 *  subtracting 24h from an instant (a spring-forward day is 23 hours long). */
function prevDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) - 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/**
 * BSP.6 — a window's IDENTITY, so "once per window entry" can be recorded.
 *
 * Content, not index: an index shifts when the operator adds or reorders a row, and a fingerprint
 * that changes for that reason would make the schedule re-assert for no reason. Editing the window
 * itself DOES change the key, which is right — a changed instruction deserves to be carried out.
 */
const windowFingerprint = (w: BSWindow): string => `${Number(w.day)}|${w.start ?? ''}|${w.end ?? ''}|${w.adj ?? ''}|${w.value ?? ''}`
const parseHHMM = (s?: string): number => { if (!s) return 0; const [h, m] = s.split(':').map((x) => parseInt(x, 10)); return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m) }

/**
 * The window active right now (matching weekday + time-of-day), or null.
 *
 * BSP-P5 — exported, and `now` injectable. This is the function that decides whether a schedule
 * does anything at all, it carries the midnight-wrap and all-day branches, and it had **no test**:
 * the two pure functions W4 pinned (`computeBudget`, `dateActive`) are the easy ones. A branch
 * that only fires at 23:00 on a Sunday is exactly the kind that a browser pass never sees.
 *
 * 3d (Owner D2) — an ALL-DAY window (no hours: Budget Multiplier) is one BUDGET day, so its weekday and
 * entry date come from `budgetDayStart` (00:00–24:00 UTC, ads-budget-day.ts), not from `tz`: it opens
 * when Amazon's budget day does, 02:00 Rome in summer and 01:00 in winter. Timed windows are clock
 * hours and stay in the schedule's own timezone.
 */
export function activeWindow(windows: BSWindow[], tz: string, now: Date = new Date()): ActiveWindow | null {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const { day, minutes, date } = nowInTz(tz, now)
  const budgetDay = { day: budgetDayStart(now).getUTCDay(), date: budgetDayKey(now) }
  /**
   * BSP.6 — `entryDate` is the calendar date the window OPENED on, which is not always today.
   * A wrapping window (23:00 → 02:00 Fri) is ONE entry that spans two dates; at 01:00 on Saturday
   * we are still inside Friday's entry. Keying on "today" would treat midnight as a second entry
   * and write twice for one window — the precise failure "once per window entry" exists to prevent.
   */
  let entryDate = date
  const win = windows.find((w) => {
    const wDay = Number(w.day)
    if (!w.start || !w.end) { entryDate = budgetDay.date; return wDay === budgetDay.day } // all-day = one budget day (UTC); never wraps
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
    if (a < b) { if (wDay === day && minutes >= a && minutes < b) { entryDate = date; return true } return false }
    // Wrapping: the pre-midnight half opened today; the post-midnight half opened YESTERDAY.
    if (wDay === day && minutes >= a) { entryDate = date; return true }
    if ((wDay + 1) % 7 === day && minutes < b) { entryDate = prevDate(date); return true }
    return false
  })
  return win ? { win, entryDate, key: `${entryDate}#${windowFingerprint(win)}` } : null
}

/** Is "today" within the schedule's start/end window and outside every exclude range?
 *  `now` is injectable for tests only; the cron always passes real time.
 *
 *  3d (N2) — the dates are BUDGET days: today, the start, the end and each blackout day all come from
 *  `budgetDayStart` (00:00 UTC, ads-budget-day.ts), the same day the all-day windows and the write gate
 *  count. A timed window late at night is in force while its budget day is in range. */
export function dateActive(s: { startDate: Date | null; endDate: Date | null; neverExpire: boolean; excludeDates: unknown }, now: Date = new Date()): boolean {
  const today = budgetDayStart(now).getTime()
  // An unreadable date compares as NaN — false both ways — so it bounds nothing, as before.
  const dayOf = (d: Date | string) => budgetDayStart(new Date(d)).getTime()
  if (s.startDate && today < dayOf(s.startDate)) return false
  if (!s.neverExpire && s.endDate && today > dayOf(s.endDate)) return false
  const ex = Array.isArray(s.excludeDates) ? s.excludeDates as Array<{ start?: string; end?: string }> : []
  for (const r of ex) {
    if (!r.start || !r.end) continue
    /**
     * W4 — the range is INCLUSIVE of its end day. The old instant comparison (`today` pinned to UTC
     * noon against `new Date(r.end)`, UTC midnight) excluded every day of the range EXCEPT the last
     * one — the operator's chosen end date was the one day the blackout did not cover. Comparing
     * budget days keeps both ends inclusive, as for the schedule's own endDate above.
     */
    if (today >= dayOf(r.start) && today <= dayOf(r.end)) return false
  }
  return true
}

/**
 * New daily budget for a window, clamped to Amazon's €1 floor.
 *
 * 4b (review 4.1) — the value is read with the shared reader: "15,50" is €15.50, not 0 → €1. A value it cannot read
 * (or a blank one) leaves the budget where it is — the same as a × 0 multiplier always did — never a €1 budget. The
 * save routes refuse such a window now; this guards the ones stored before.
 */
export function computeBudget(base: number, type: string, adj?: string, value?: number | string): number {
  const read = parseDecimalInput(value)
  const v = read.ok ? read.value : null
  let next = base
  if (v == null) next = base // unreadable or blank: the budget stays
  else if (type === 'budget-multiplier') next = base * (v || 1)
  else if (adj === 'set') next = v
  else if (adj === 'incPct') next = base * (1 + v / 100)
  else if (adj === 'decPct') next = base * (1 - v / 100)
  return Math.max(1, Math.round(next * 100) / 100) // €1 Amazon minimum
}

/**
 * BSP-P3 — what the memo records, per campaign.
 *
 * `budget` is unchanged — the value this record last asked for — so this shape is purely
 * ADDITIVE — no migration, and a row written before this change still reads correctly
 * (`ownCentsOf` / `baseCentsOf` read the older rows).
 *
 * `state` is the word the tab needs and never had:
 *   · `applied` — we asked for it and the local write + enqueue succeeded;
 *   · `held`    — the live budget already equals the target, so there was nothing to do;
 *   · `yielded` — 🔴 another writer moved this budget away from our target after we set it, and we
 *                 stand down for the rest of this window entry — and, since 3b, give nothing back
 *                 when it closes. BSP.6 adds `overriddenBy`, so the tab can say WHO — the pacer, a
 *                 rule, or the operator's own hand;
 *   · `refused` — the mutation layer declined (`ok:false`), which it does by RETURN VALUE; or (3b) a
 *                 give-back was given up after GIVE_BACK_RETRIES tries that did not reach Amazon; or (3c) the
 *                 window entry's queued write did not reach Amazon and Nexus's copy went back (4k);
 *   · `failed`  — the call threw.
 *
 * `actionLogId` / `outboundQueueId` are the receipt handles. They only exist on the outcome
 * object, so the old bare `await` dropped them along with the failure signal.
 *
 * ── BSP.6 — `windowKey` is the field that makes the rule a RULE ────────────────────────────────
 *
 * The old memo was keyed on the TARGET VALUE (`last.budget === target → skip`). That happened to
 * behave like "once per window", but only as a side effect of the end-of-window restore resetting
 * it: any day the restore was blocked, the next day's window silently did nothing. Behaviour that
 * is accidentally correct stops being correct without anyone noticing.
 *
 * `windowKey` states it instead — `<entryDate>#<windowFingerprint>` while a window is open, and
 * `<thatKey>#restore` for the single give-back that follows it. Same intent, now durable across a
 * failed restore, and immune to the value collision the old key had.
 */
export interface BSApplied {
  budget: number
  at: string
  state?: 'applied' | 'held' | 'yielded' | 'refused' | 'failed'
  /** What the campaign's budget actually was when we looked — the evidence behind `yielded`. */
  live?: number
  /** BSP.6 — the window entry (or restore) this memo belongs to. Absent on pre-BSP.6 rows. */
  windowKey?: string
  /** BSP.6 — who moved it out from under us. Present only on `yielded`. */
  overriddenBy?: { kind: BSOverrideKind; label: string; actor: string; at: string }
  actionLogId?: string | null
  outboundQueueId?: string | null
  error?: string | null
  /** 3b — the budget just before the window opened, in cents: what the give-back puts back. */
  baseCents?: number | null
  /** 3b — the budget this schedule set, in cents. The give-back is written only while the campaign sits at it. */
  ownCents?: number | null
  /** 3b — give-back tries for this entry so far. */
  attempts?: number
  /** 3b — when a give-back that did not land may be tried again (ISO). */
  nextRetryAt?: string | null
}

/**
 * 3b — a give-back that did not reach Amazon (the gate SKIPPED it, the call FAILED, or the mutation
 * layer refused it) is tried again once an hour, while the campaign still sits at this schedule's
 * value, at most this many times after the first try. Then it shows as refused and a person decides.
 */
export const GIVE_BACK_RETRIES = 24
const GIVE_BACK_RETRY_MS = 60 * 60_000
const RESTORE = '#restore'
/** Outbound queue states in which a write did not reach Amazon. SKIPPED is the write gate's. */
const NOT_LANDED = new Set(['SKIPPED', 'FAILED', 'CANCELLED'])
const toCents = (euros: number): number => Math.round(euros * 100)
const eur = (cents: number): string => `€${(cents / 100).toFixed(2)}`

/**
 * 3b — the budget this schedule set, in cents; null when it set none. A record written before 3b has
 * no `ownCents`: there `budget` is the value it set — unless the record is a refusal or a failure
 * (its `budget` may be the live value it found) or a give-back (its `budget` is the base).
 */
export function ownCentsOf(prev: BSApplied | undefined): number | null {
  if (!prev) return null
  if (prev.ownCents !== undefined) return prev.ownCents
  if (prev.budget == null || prev.state === 'refused' || prev.state === 'failed' || prev.windowKey?.endsWith(RESTORE)) return null
  return toCents(Number(prev.budget))
}

/** 3b — what a give-back puts back, in cents. A record written before 3b has none: the creation-time snapshot stands in. */
export function baseCentsOf(prev: BSApplied | undefined, legacyBaseCents: number | null): number | null {
  return prev?.baseCents ?? legacyBaseCents ?? null
}

/**
 * 3b — THE "is it still ours?" check, shared by the give-back when a window closes and by pause/delete
 * (`restoreBudgetScheduleBase`):
 *   · `giveBack` — the campaign still sits at the value this schedule set, and that is not the base;
 *   · `kept`     — someone else moved it since (a person, a rule, the pacer): their change wins;
 *   · `nothing`  — this schedule set nothing, or the budget already is the base.
 */
export function giveBackCheck(prev: BSApplied | undefined, liveCents: number, legacyBaseCents: number | null): { act: 'giveBack' | 'kept' | 'nothing'; baseCents: number | null; ownCents: number | null } {
  const ownCents = ownCentsOf(prev)
  const baseCents = baseCentsOf(prev, legacyBaseCents)
  if (ownCents == null || baseCents == null || liveCents === baseCents) return { act: 'nothing', baseCents, ownCents }
  return { act: liveCents === ownCents ? 'giveBack' : 'kept', baseCents, ownCents }
}

/** 3b — what one campaign needs this run: nothing, a new record and no write, or one write. */
export type BSDecision =
  | { act: 'none' }
  | { act: 'keep'; record: BSApplied; outcome?: 'yielded' | 'refused' }
  | { act: 'write'; purpose: 'enter' | 'giveBack'; windowKey: string; targetCents: number; baseCents: number; ownCents: number; attempts?: number; giveBackOf?: string }

/** 3b — the give-back is given up: shown as refused, no longer tried, and no longer waiting on a queue row. */
function gaveUpRecord(prev: BSApplied, at: string, live: number, windowKey: string, tries: number, baseCents: number, ownCents: number, last: string | null): BSApplied {
  return {
    ...prev, at, live, state: 'refused', windowKey, attempts: tries, nextRetryAt: null, outboundQueueId: null,
    error: `not given back: ${tries} tries did not reach Amazon${last ? ` (last: ${last})` : ''}. The campaign keeps ${eur(ownCents)}; change it by hand if it should go back to ${eur(baseCents)}`,
  }
}

/** 3b — a give-back try that did not land at once (refused or failed): tried again in an hour, or given up. */
export function missedGiveBackRecord(prev: BSApplied, d: Extract<BSDecision, { act: 'write' }>, now: Date, live: number, state: 'refused' | 'failed', error: string | null): BSApplied {
  const tries = d.attempts ?? 1
  if (tries > GIVE_BACK_RETRIES) return gaveUpRecord(prev, now.toISOString(), live, d.windowKey, tries, d.baseCents, d.ownCents, error)
  return { ...prev, at: now.toISOString(), state, live, error, attempts: tries, nextRetryAt: new Date(now.getTime() + GIVE_BACK_RETRY_MS).toISOString() }
}

/**
 * 3b — the decision for one campaign, pure. `liveCents` is its budget now; `active` the window open
 * now (null outside every window or outside the schedule's dates); `legacyBaseCents` the
 * creation-time snapshot, read only for records written before 3b; `giveBack` what became of the
 * queued write when the previous record is a give-back.
 */
export function decideCampaign(
  prev: BSApplied | undefined,
  liveCents: number,
  active: ActiveWindow | null,
  legacyBaseCents: number | null,
  // `giveBack`: what became of the previous record's queued write — a give-back's (3b) or, 3c, the window entry's.
  ctx: { type: string; now: Date; giveBack?: { status: string | null; error: string | null } | null },
): BSDecision {
  const at = ctx.now.toISOString()
  const live = liveCents / 100

  if (active) {
    // Already handled this entry: report reality, write nothing.
    if (prev?.windowKey === active.key) {
      if (liveCents === ownCentsOf(prev)) return { act: 'keep', record: { ...prev, at, state: 'held', live } }
      // Carry the entry key (so we stay stood down) and the receipt handles (so delivery still
      // resolves) — but NOT a stale `overriddenBy`: it is re-resolved by the caller, and showing last
      // tick's attributor for a yield we could not attribute this tick would be a fabrication.
      const { overriddenBy: _stale, ...carried } = prev
      // 3c — since 4k the worker puts a write the gate refused back in Nexus, so the budget moves away from ours with
      // no one else's change. When this entry's own write did not reach Amazon, that is a refusal — the queue row says
      // why — not a yield. Still stood down for this entry: the next entry tries again.
      const st = ctx.giveBack?.status ?? null
      if (st != null && NOT_LANDED.has(st)) {
        return { act: 'keep', record: { ...carried, at, state: 'refused', live, error: ctx.giveBack?.error ?? prev.error ?? null }, outcome: 'refused' }
      }
      return { act: 'keep', record: { ...carried, at, state: 'yielded', live }, outcome: 'yielded' }
    }
    // A new entry. 🔴 S14 — the base is the budget just before the window: the live value, unless the
    // campaign still sits at what this schedule set; then the base recorded with that value stands.
    const own = ownCentsOf(prev)
    const recorded = baseCentsOf(prev, legacyBaseCents)
    const baseCents = own != null && liveCents === own && recorded != null ? recorded : liveCents
    const targetCents = toCents(computeBudget(baseCents / 100, ctx.type, active.win.adj, active.win.value))
    // Reality already matches the new entry — nothing to do, but the entry is satisfied.
    if (liveCents === targetCents) {
      return { act: 'keep', record: { budget: targetCents / 100, at, state: 'held', live, windowKey: active.key, baseCents, ownCents: targetCents } }
    }
    return { act: 'write', purpose: 'enter', windowKey: active.key, targetCents, baseCents, ownCents: targetCents }
  }

  // Out of window. No record, or one older than BSP.6 (no entry key): nothing is owed. 6.6 — a record
  // is KEPT outside windows; it is the only place the screen can read what became of a give-back.
  if (!prev) return { act: 'none' }
  const wk = prev.windowKey
  if (!wk) return { act: 'keep', record: prev }
  const isRestore = wk.endsWith(RESTORE)
  const entryKey = isRestore ? wk.slice(0, -RESTORE.length) : wk
  const restoreKey = `${entryKey}${RESTORE}`
  const check = giveBackCheck(prev, liveCents, legacyBaseCents)
  const tries = prev.attempts ?? 0

  if (!isRestore) {
    // The entry this record belongs to has closed: its give-back is owed now — if the budget is still ours.
    if (check.act === 'kept') {
      const { overriddenBy: _stale, ...carried } = prev
      return { act: 'keep', record: { ...carried, at, state: 'yielded', live, windowKey: restoreKey }, outcome: 'yielded' }
    }
    if (check.act === 'nothing') return { act: 'keep', record: { ...prev, at, state: 'held', live, windowKey: restoreKey } }
  } else {
    // The give-back was decided. Only one that did not land is tried again, and only while the
    // campaign still sits at this schedule's value: Amazon may have refused it and the sync copied
    // Amazon's budget back. Anything else keeps the record as it is.
    const st = ctx.giveBack?.status ?? null
    const missed = prev.state === 'refused' || prev.state === 'failed' || (prev.state === 'applied' && st != null && NOT_LANDED.has(st))
    if (!missed || check.act !== 'giveBack') return { act: 'keep', record: prev }
    if (prev.state === 'refused' && tries > GIVE_BACK_RETRIES) return { act: 'keep', record: prev } // given up already
  }
  const baseCents = check.baseCents as number
  const ownCents = check.ownCents as number
  if (tries > GIVE_BACK_RETRIES) {
    return { act: 'keep', record: gaveUpRecord(prev, at, live, restoreKey, tries, baseCents, ownCents, ctx.giveBack?.error ?? prev.error ?? null), outcome: 'refused' }
  }
  if (prev.nextRetryAt && ctx.now.getTime() < Date.parse(prev.nextRetryAt)) return { act: 'keep', record: prev }
  return { act: 'write', purpose: 'giveBack', windowKey: restoreKey, targetCents: baseCents, baseCents, ownCents, attempts: tries + 1, giveBackOf: entryKey }
}

/**
 * BSP.6 — who owns a budget when this schedule does not.
 *
 * `pacer` is the one that matters: `automation:budget-manager-cron` enforces the monthly envelope
 * (`AdBudgetPlan`, €4,000/mo across IT/DE/ES/FR). The plan is the AUTHORITY and a schedule is a
 * shape within it, so yielding to the pacer is correct behaviour, not a defeat — but the operator
 * has to be told it happened, and by whom, or the tab is claiming a window that is not in force.
 */
export type BSOverrideKind = 'pacer' | 'rule' | 'operator' | 'schedule' | 'job'

export function classifyOverride(actor: string | null | undefined): { kind: BSOverrideKind; label: string } {
  const a = actor ?? ''
  if (!a) return { kind: 'job', label: 'an unattributed writer' }
  if (!a.startsWith('automation:')) return { kind: 'operator', label: 'you, by hand' }
  const rest = a.slice('automation:'.length)
  if (rest === 'budget-manager-cron' || rest.startsWith('budget-manager')) return { kind: 'pacer', label: 'the budget pacer holding the monthly envelope' }
  if (rest.startsWith('budget-schedule-')) return { kind: 'schedule', label: 'another budget schedule' }
  // A bare cuid after `automation:` is a rule id — the same shape SG.0 established in the change
  // feed's parseActor. The rule's NAME is resolved by the caller, which batches the lookup.
  if (/^c[a-z0-9]{20,}$/.test(rest)) return { kind: 'rule', label: 'a budget rule' }
  return { kind: 'job', label: rest.replace(/-/g, ' ') }
}

// 1d — `guard`: the dial posture and the caps this run ran under, and what they held back.
// ONE BRAIN AB-6 — `leverHeld`: the writes it left because a product's brain owns the campaign's daily budget (or the
// Owner holds it at his own value), per lever; `leverHoldsUnread`: who holds them could not be read (the gate decided).
export interface BSTick { evaluated: number; changed: number; yielded: number; refused: number; guard?: EngineGuardReport; leverHeld?: LeverHeld; leverHoldsUnread?: boolean }

export async function runBudgetScheduleOnce(now: Date = new Date()): Promise<BSTick> {
  const schedules = await prisma.budgetSchedule.findMany({
    where: { kind: 'BUDGET', enabled: true },
    // BSP-P4 — deterministic order. H10's law is "settings for the MOST RECENTLY CREATED schedule
    // apply if there are any time or state conflicts", and with no `orderBy` the last writer in an
    // arbitrary loop won by accident. Oldest first means the newest schedule writes LAST and its
    // value is the one left standing — H10's rule, made real rather than incidental.
    orderBy: { createdAt: 'asc' },
  })
  let changed = 0
  let yielded = 0
  let refused = 0
  // 1d — the account dial and this engine's caps, read once per run; each campaign asks before its one write.
  const guard = schedules.length ? await openEngineGuard('budget-schedules') : null
  // ONE BRAIN AB-6 — who holds the daily budgets of every scheduled campaign, read once per run (brain/engine-skips.ts):
  // a write — a window's or a give-back's — on a budget a product's brain owns, or the Owner holds at his own value, is
  // left, and the memo is carried as when the dial holds it back, so the schedule acts on its first run allowed to.
  // Every schedule's actor is the same kind of writer at the gate (automation:budget-schedule-<id>).
  const leverHolds = await readLeverHolds(
    schedules.flatMap((s) => ((s.campaigns as unknown as BSCampaign[]) ?? []).map((c) => c.id)),
    { actor: 'automation:budget-schedule' },
    'budget-schedules',
  )
  for (const s of schedules) {
    const windows = (s.windows as unknown as BSWindow[]) ?? []
    const camps = (s.campaigns as unknown as BSCampaign[]) ?? []
    const within = dateActive(s, now)
    const active = within ? activeWindow(windows, s.timezone, now) : null
    const last = (s.lastApplied as unknown as Record<string, BSApplied> | null) ?? {}
    const nextLast: Record<string, BSApplied> = {}
    /** BSP.6 — campaigns that yielded this tick; their overriders are resolved in ONE query below. */
    const yieldedIds: string[] = []
    // 3b — what became of each give-back's queued write (SKIPPED by the gate → tried again), in ONE query.
    // 3c — and of each window entry's: refused by the gate, it is shown refused rather than yielded.
    const giveBackQueueIds = Object.values(last).filter((r) => r?.windowKey && r.outboundQueueId).map((r) => r.outboundQueueId as string)
    const giveBackRows = giveBackQueueIds.length
      ? await prisma.outboundSyncQueue.findMany({ where: { id: { in: giveBackQueueIds } }, select: { id: true, syncStatus: true, errorMessage: true } })
      : []
    const giveBackById = new Map(giveBackRows.map((q) => [q.id, { status: String(q.syncStatus), error: q.errorMessage ?? null }]))

    for (const c of camps) {
      // 3b — `budgetBaselineCents` is no longer read here: it is the rules' anchor (group 4), not the
      // budget a schedule found before its window (review 6.3).
      const campaign = await prisma.campaign.findUnique({ where: { id: c.id }, select: { dailyBudget: true, status: true } })
      if (!campaign || campaign.status === 'ARCHIVED') continue
      const live = Number(campaign.dailyBudget ?? 0)
      const at = now.toISOString()
      const prev = last[c.id]

      /**
       * ── 🔴 BSP.6 — THE PRECEDENCE RULE, stated ────────────────────────────────────────────────
       *
       * **A schedule owns a campaign only while its own window is open, and writes once per window
       * entry. Outside that, it gives the budget back exactly once and then leaves the campaign
       * alone.**
       *
       * Approved by the operator 2026-08-22 over the two alternatives:
       *   · *Re-fight the pacer every tick.* Refused with evidence. `budget_day_move` caps
       *     CUMULATIVE movement per UTC day at −30%/+50%-or-€10 across every writer, so an
       *     oscillation spends that allowance in a few ticks and then blocks BOTH engines for the
       *     rest of the day. 41% of the audit chain is already broken from exactly this pattern.
       *   · *Copy Helium 10.* H10's published rule is "same direction → the greater change; opposite
       *     direction → no change at all" — a CRITERIA-conflict rule. H10 has no pacer, so it never
       *     had this conflict. Measured here, the pacer raised 18 and cut 18 campaigns in 24h, so
       *     that rule would decide the fate of an evening lift on a coin flip unrelated to its
       *     merits. H10's OTHER rule — newest schedule wins a schedule-vs-schedule conflict — does
       *     apply and is honoured by the `createdAt asc` ordering above.
       *
       * Why yielding is right rather than merely safe: `AdBudgetPlan` (€4,000/month) is the
       * AUTHORITY over how much money exists, and a schedule is a SHAPE within it. An instrument
       * overriding its own authority is incoherent. So the schedule stands down — and says who to.
       *
       * 3b — and the give-back yields too: it is written only while the campaign still sits at the
       * value this schedule set (`decideCampaign`). It used to put the base back whatever the live
       * value was, overwriting a person's, a rule's, the pacer's or a newer schedule's change (6.2, 6.8).
       *
       * Out of window with nothing owed → **no write.** (BSP.6: the old executor asserted `base` on
       * every tick outside a window, moving budgets before a new schedule's first window had opened.)
       */
      const legacyBaseCents = c.dailyBudget != null ? toCents(Number(c.dailyBudget)) : null
      const giveBack = prev?.outboundQueueId ? giveBackById.get(prev.outboundQueueId) ?? null : null
      const d = decideCampaign(prev, toCents(live), active, legacyBaseCents, { type: s.type, now, giveBack })
      if (d.act === 'none') continue
      if (d.act === 'keep') {
        nextLast[c.id] = d.record
        if (d.outcome === 'yielded') {
          yielded++
          yieldedIds.push(c.id)
          logger.info('[budget-schedule] yielded — another writer owns this budget', { scheduleId: s.id, campaignId: c.id, live, windowKey: d.record.windowKey })
        } else if (d.outcome === 'refused') {
          refused++
          logger.warn('[budget-schedule] give-back given up — it never reached Amazon', { scheduleId: s.id, campaignId: c.id, live, error: d.record.error })
        }
        continue
      }
      const target = d.targetCents / 100
      const isGiveBack = d.purpose === 'giveBack'

      const leverHeld = leverHolds.skip(c.id, 'budgets')
      if (leverHeld) {
        if (prev) nextLast[c.id] = prev
        logger.info('[budget-schedule] left alone — one owner per lever', { scheduleId: s.id, campaignId: c.id, target, giveBack: isGiveBack, why: leverHeld.reason })
        continue
      }

      /**
       * 1d — the dial and the caps, asked once per campaign before its one write. Entering a window is a new
       * change: capped, and not written under SUGGEST or while stopped. The give-back after a window is its own
       * state: never refused by a cap and still written under SUGGEST, but it waits while stopped (the gate
       * refuses a budget write while stopped, and only after Nexus changed its own copy).
       * 🔴 Held back, the entry key is NOT committed — the previous memo is carried instead, exactly as on a
       * refusal — so the window is entered properly, and a give-back still owed is still owed, on the first run
       * allowed to write.
       */
      const permit = guard!.permit()
      const held = nothingHeld()
      if (!allowChange(true, permit, held, isGiveBack ? 'restore' : 'forward')) {
        guard!.settle(permit, 0, held)
        if (prev) nextLast[c.id] = prev
        continue
      }
      let writes = 0

      try {
        /**
         * 🔴 BSP-P3 — `updateCampaignWithSync` FAILS BY RETURN VALUE, never by throwing
         * ([[reference_mutation_outcome_returned_not_thrown]]): an unknown campaign comes back
         * `{ ok:false, error:'not_found' }` and the `catch` below never runs. The old call was a
         * bare `await` under two `as never` casts, so a refusal was counted in `changed`, logged
         * as "applied", and MEMOISED — and the memo guard above then skipped the campaign on every
         * later tick. The comment promising "retried, not laundered into success" described only
         * the throwing path, which is the rare one.
         *
         * The `as never` casts are gone with it: they are what let this compile without anyone
         * having to look at the return type ([[reference_as_never_hides_write_failures]]).
         */
        const outcome = await updateCampaignWithSync({
          campaignId: c.id,
          patch: { dailyBudget: target },
          actor: `automation:budget-schedule-${s.id}`,
          reason: isGiveBack ? `budget schedule: window closed → give back €${target}, the budget before the window` : `budget schedule: window → €${target}`,
          applyImmediately: true,
          // 3b — the entry this write gives back, for the history (the gate reads the action log, not this).
          ...(d.giveBackOf ? { evidence: { giveBackOf: d.giveBackOf } } : {}),
        })
        if (!outcome.ok) {
          refused++
          /**
           * 🔴 The entry key is NOT committed here. That is the whole point of keying on the entry
           * rather than the value: a refused write leaves the entry unhandled, so the next tick
           * tries it again — and the previous entry's key is carried so a later give-back still
           * knows which entry it owes. 3b — a refused give-back is tried again in an hour, not the next tick.
           */
          if (isGiveBack && prev) nextLast[c.id] = missedGiveBackRecord(prev, d, now, live, 'refused', outcome.error ?? null)
          else if (prev?.budget != null) nextLast[c.id] = { ...prev, at, state: 'refused', live, error: outcome.error ?? null }
          else nextLast[c.id] = { budget: live, at, state: 'refused', live, error: outcome.error ?? null }
          logger.warn('[budget-schedule] refused by the mutation layer — will retry', { scheduleId: s.id, campaignId: c.id, target, giveBack: isGiveBack, error: outcome.error })
          continue
        }
        /**
         * 🔴 `.ok` is a THREE-way answer, not a boolean about whether anything happened.
         * `{ ok: true, error: 'no_changes' }` (ads-mutation.service.ts:679) is returned when the
         * patch diffed to nothing — the local row already held the target. It enqueues no job, so
         * `outboundQueueId` is null. Recording that as `applied` would park the row at "in flight"
         * forever, waiting on a queue entry that will never exist. It is `held`: nothing to do.
         *
         * Reachable only by a race — the loop's own `live === target` check ran a moment earlier —
         * but "rare" is how the memo laundering got in, and the honest branch costs one line.
         */
        if (outcome.error === 'no_changes' || outcome.outboundQueueId == null) {
          nextLast[c.id] = { budget: target, at, state: 'held', live, windowKey: d.windowKey, baseCents: d.baseCents, ownCents: d.ownCents }
          logger.info('[budget-schedule] no change to make', { scheduleId: s.id, campaignId: c.id, target })
          continue
        }
        changed++
        writes = 1
        /**
         * ⚠ `ok: true` means WRITTEN LOCALLY AND QUEUED — not landed at Amazon. The write gate runs
         * later, in the sync worker (`WRITE_GATE_DENIED` exists only there), and on this account it
         * skipped 298 of 398 budget writes in 7 days (`campaign_allowlist`, `budget_day_move`). The
         * delivery answer therefore lives on `OutboundSyncQueue.syncStatus`, which is why the queue
         * id is kept here: it is the handle the tab uses to ask "did this actually reach Amazon?"
         * rather than assuming. [[reference_mutation_outcome_returned_not_thrown]]
         * 3b — and for a give-back, the handle the next runs read to try it again if it was SKIPPED.
         */
        nextLast[c.id] = {
          budget: target, at, state: 'applied', live, windowKey: d.windowKey, baseCents: d.baseCents, ownCents: d.ownCents,
          actionLogId: outcome.actionLogId, outboundQueueId: outcome.outboundQueueId,
          ...(isGiveBack ? { attempts: d.attempts, nextRetryAt: new Date(now.getTime() + GIVE_BACK_RETRY_MS).toISOString() } : {}),
        }
        logger.info('[budget-schedule] applied locally + queued', { scheduleId: s.id, campaignId: c.id, budget: target, giveBack: isGiveBack, windowKey: d.windowKey, outboundQueueId: outcome.outboundQueueId })
      } catch (e) {
        // Same as the refusal path: the entry key stays uncommitted so the next tick retries.
        if (isGiveBack && prev) nextLast[c.id] = missedGiveBackRecord(prev, d, now, live, 'failed', (e as Error).message)
        else if (prev?.budget != null) nextLast[c.id] = { ...prev, at, state: 'failed', live, error: (e as Error).message }
        else nextLast[c.id] = { budget: live, at, state: 'failed', live, error: (e as Error).message }
        logger.warn('[budget-schedule] apply failed — will retry', { scheduleId: s.id, campaignId: c.id, giveBack: isGiveBack, error: (e as Error).message })
      } finally {
        guard!.settle(permit, writes, held)
      }
    }

    /**
     * 🔴 BSP.6 item 2 — name the counterparty, in ONE query for the whole schedule.
     *
     * `AdvertisingActionLog.userId` identified the last writer for 36 of 36 campaigns touched in
     * 24h, so this is a real reading, not a guess. We ask for the newest budget write that was not
     * ours; a yield with no such row is left unattributed rather than blamed on anyone.
     */
    if (yieldedIds.length > 0) {
      const meActor = `automation:budget-schedule-${s.id}`
      const rows = await prisma.$queryRaw<Array<{ entityId: string; userId: string | null; createdAt: Date }>>`
        SELECT DISTINCT ON ("entityId") "entityId", "userId", "createdAt"
        FROM "AdvertisingActionLog"
        WHERE "actionType" = 'AD_BUDGET_UPDATE'
          AND "entityType" = 'CAMPAIGN'
          AND "entityId" = ANY(${yieldedIds}::text[])
          AND ("userId" IS NULL OR "userId" <> ${meActor})
        ORDER BY "entityId", "createdAt" DESC`
      // One name lookup for every rule actor seen, rather than one per campaign.
      const ruleIds = [...new Set(rows.map((r) => r.userId ?? '').filter((a) => classifyOverride(a).kind === 'rule').map((a) => a.slice('automation:'.length)))]
      const ruleNames = ruleIds.length
        ? new Map((await prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]))
        : new Map<string, string>()
      for (const r of rows) {
        const memo = nextLast[r.entityId]
        if (!memo || memo.state !== 'yielded') continue
        const cls = classifyOverride(r.userId)
        const name = cls.kind === 'rule' ? ruleNames.get((r.userId ?? '').slice('automation:'.length)) : undefined
        memo.overriddenBy = {
          kind: cls.kind,
          label: name ? `the rule “${name}”` : cls.label,
          actor: r.userId ?? 'unknown',
          at: r.createdAt.toISOString(),
        }
      }
    }
    await prisma.budgetSchedule.update({ where: { id: s.id }, data: { lastApplied: nextLast as unknown as Prisma.InputJsonValue, lastEvaluatedAt: new Date() } })
  }
  const leverHeld = leverHolds.counts()
  logger.info('[budget-schedule] tick', { evaluated: schedules.length, changed, yielded, refused, ...(leverHolds.total() ? { leverHeld } : {}) })
  return {
    evaluated: schedules.length, changed, yielded, refused, ...(guard ? { guard: guard.report() } : {}),
    ...(leverHolds.total() ? { leverHeld } : {}), ...(leverHolds.unread ? { leverHoldsUnread: true } : {}),
  }
}

/** 1d — the run's summary line: the counts, plus what the dial or the caps held back (nothing extra on a normal run). */
export function budgetScheduleSummaryLine(r: BSTick): string {
  return `evaluated=${r.evaluated} changed=${r.changed} yielded=${r.yielded} refused=${r.refused}${engineGuardNote(r.guard, {
    suggest: 'no window is entered; a budget it set is still given back when its window closes',
    stopped: 'nothing is written; windows and give-backs wait for Resume',
  })}${leverHeldNote(r.leverHeld, r.leverHoldsUnread)}`
}

export async function runBudgetScheduleCron(): Promise<void> {
  // BSP-P3 — the summary carries the refusals too. A green cron row that reports only `changed`
  // reads as "all good" while every write is being stood down: [[reference_cron_success_carries_sweeper_error]].
  try { await recordCronRun('ad-budget-schedule', async () => budgetScheduleSummaryLine(await runBudgetScheduleOnce())) }
  catch (err) { logger.error('ad-budget-schedule cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false // overlap guard
export function startBudgetScheduleCron(): void {
  if (task) return
  task = cron.schedule('*/15 * * * *', async () => {
    if (running) { await logger.warn('[ad-budget-schedule] previous tick still in flight — skipping'); return }
    running = true
    await runBudgetScheduleCron().finally(() => { running = false })
  })
  logger.info('ad-budget-schedule cron scheduled (*/15 * * * *)')
}
