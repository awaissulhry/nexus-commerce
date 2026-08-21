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
 * The delete/disable give-back (`bsRestoreBase`, advertising.routes.ts) is a SEPARATE mechanism and
 * is deliberately untouched by this rule — it runs when the operator removes the schedule.
 */
import cron from 'node-cron'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { updateCampaignWithSync } from '../services/advertising/ads-mutation.service.js'

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
 */
export function activeWindow(windows: BSWindow[], tz: string, now: Date = new Date()): ActiveWindow | null {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const { day, minutes, date } = nowInTz(tz, now)
  /**
   * BSP.6 — `entryDate` is the calendar date the window OPENED on, which is not always today.
   * A wrapping window (23:00 → 02:00 Fri) is ONE entry that spans two dates; at 01:00 on Saturday
   * we are still inside Friday's entry. Keying on "today" would treat midnight as a second entry
   * and write twice for one window — the precise failure "once per window entry" exists to prevent.
   */
  let entryDate = date
  const win = windows.find((w) => {
    const wDay = Number(w.day)
    if (!w.start || !w.end) { entryDate = date; return wDay === day } // all-day windows never wrap
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
 *  `now` is injectable for tests only; the cron always passes real time. */
export function dateActive(s: { startDate: Date | null; endDate: Date | null; neverExpire: boolean; excludeDates: unknown }, now: Date = new Date()): boolean {
  const today = new Date(now); today.setUTCHours(12, 0, 0, 0)
  if (s.startDate && today < new Date(new Date(s.startDate).setUTCHours(0, 0, 0, 0))) return false
  if (!s.neverExpire && s.endDate && today > new Date(new Date(s.endDate).setUTCHours(23, 59, 59, 0))) return false
  const ex = Array.isArray(s.excludeDates) ? s.excludeDates as Array<{ start?: string; end?: string }> : []
  for (const r of ex) {
    if (!r.start || !r.end) continue
    /**
     * W4 — the range is INCLUSIVE of its end day. A date-only ISO string parses to UTC midnight,
     * and `today` is pinned to UTC noon, so the bare `today <= new Date(r.end)` excluded every day
     * of the range EXCEPT the last one — the operator's chosen end date was the one day the
     * blackout did not cover. Same end-of-day treatment as the schedule's own endDate above.
     */
    const start = new Date(new Date(r.start).setUTCHours(0, 0, 0, 0))
    const end = new Date(new Date(r.end).setUTCHours(23, 59, 59, 0))
    if (today >= start && today <= end) return false
  }
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

/**
 * BSP-P3 — what the memo records, per campaign.
 *
 * `budget` is unchanged and is still the churn key every existing reader uses
 * (`bsRestoreBase` in advertising.routes.ts reads `last[id]?.budget`), so this shape is purely
 * ADDITIVE — no migration, and a row written before this change still reads correctly.
 *
 * `state` is the word the tab needs and never had:
 *   · `applied` — we asked for it and the local write + enqueue succeeded;
 *   · `held`    — the live budget already equals the target, so there was nothing to do;
 *   · `yielded` — 🔴 another writer moved this budget away from our target after we set it, and we
 *                 stand down for the rest of this window entry. BSP.6 adds `overriddenBy`, so the
 *                 tab can say WHO — the pacer, a rule, or the operator's own hand;
 *   · `refused` — the mutation layer declined (`ok:false`), which it does by RETURN VALUE;
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
interface BSApplied {
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

export interface BSTick { evaluated: number; changed: number; yielded: number; refused: number }

export async function runBudgetScheduleOnce(): Promise<BSTick> {
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
  for (const s of schedules) {
    const windows = (s.windows as unknown as BSWindow[]) ?? []
    const camps = (s.campaigns as unknown as BSCampaign[]) ?? []
    const within = dateActive(s)
    const active = within ? activeWindow(windows, s.timezone) : null
    const win = active?.win ?? null
    const last = (s.lastApplied as unknown as Record<string, BSApplied> | null) ?? {}
    const nextLast: Record<string, BSApplied> = {}
    /** BSP.6 — campaigns that yielded this tick; their overriders are resolved in ONE query below. */
    const yieldedIds: string[] = []

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
      const at = new Date().toISOString()
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
       */
      const owedRestoreKey = prev?.windowKey && !prev.windowKey.endsWith('#restore') ? `${prev.windowKey}#restore` : null
      const entryKey = active ? active.key : owedRestoreKey

      /**
       * Out of window with nothing owed → **do not touch this campaign at all.**
       *
       * ⚠ This is a deliberate contract change. The old executor asserted `base` on every tick it
       * was outside a window, which meant a brand-new schedule moved budgets before its first
       * window had ever opened, and kept re-asserting base against the pacer forever. Neither is
       * this object's job: outside its hours a schedule has no claim on the campaign. The
       * give-back still happens — once, keyed to the entry it is giving back — and the
       * delete/disable restore path (`bsRestoreBase`) is a separate mechanism, untouched.
       */
      if (entryKey == null) continue

      // Already handled this entry: report reality, write nothing.
      if (prev?.windowKey === entryKey) {
        if (live === target) { nextLast[c.id] = { ...prev, at, state: 'held', live }; continue }
        yielded++
        yieldedIds.push(c.id)
        // Carry the entry key (so we stay stood down) and the receipt handles (so delivery still
        // resolves) — but NOT a stale `overriddenBy`: it is re-resolved below, and showing last
        // tick's attributor for a yield we could not attribute this tick would be a fabrication.
        const { overriddenBy: _stale, ...carried } = prev
        nextLast[c.id] = { ...carried, at, state: 'yielded', live }
        logger.info('[budget-schedule] yielded — another writer owns this budget for the rest of the entry', { scheduleId: s.id, campaignId: c.id, target, live, entryKey })
        continue
      }

      // A new entry, and reality already matches it — nothing to do, but the entry is satisfied.
      if (live === target) { nextLast[c.id] = { budget: target, at, state: 'held', live, windowKey: entryKey }; continue }

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
          reason: win ? `budget schedule: window → €${target}` : 'budget schedule: outside window → base',
          applyImmediately: true,
        })
        if (!outcome.ok) {
          refused++
          /**
           * 🔴 The entry key is NOT committed here. That is the whole point of keying on the entry
           * rather than the value: a refused write leaves the entry unhandled, so the next tick
           * tries it again — and the previous entry's key is carried so a later give-back still
           * knows which entry it owes.
           */
          if (prev?.budget != null) nextLast[c.id] = { ...prev, at, state: 'refused', live, error: outcome.error ?? null }
          else nextLast[c.id] = { budget: live, at, state: 'refused', live, error: outcome.error ?? null }
          logger.warn('[budget-schedule] refused by the mutation layer — will retry next tick', { scheduleId: s.id, campaignId: c.id, target, error: outcome.error })
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
          nextLast[c.id] = { budget: target, at, state: 'held', live, windowKey: entryKey }
          logger.info('[budget-schedule] no change to make', { scheduleId: s.id, campaignId: c.id, target })
          continue
        }
        changed++
        /**
         * ⚠ `ok: true` means WRITTEN LOCALLY AND QUEUED — not landed at Amazon. The write gate runs
         * later, in the sync worker (`WRITE_GATE_DENIED` exists only there), and on this account it
         * skipped 298 of 398 budget writes in 7 days (`campaign_allowlist`, `budget_day_move`). The
         * delivery answer therefore lives on `OutboundSyncQueue.syncStatus`, which is why the queue
         * id is kept here: it is the handle the tab uses to ask "did this actually reach Amazon?"
         * rather than assuming. [[reference_mutation_outcome_returned_not_thrown]]
         */
        nextLast[c.id] = { budget: target, at, state: 'applied', live, windowKey: entryKey, actionLogId: outcome.actionLogId, outboundQueueId: outcome.outboundQueueId }
        logger.info('[budget-schedule] applied locally + queued', { scheduleId: s.id, campaignId: c.id, budget: target, inWindow: !!win, entryKey, outboundQueueId: outcome.outboundQueueId })
      } catch (e) {
        // Same as the refusal path: the entry key stays uncommitted so the next tick retries.
        if (prev?.budget != null) nextLast[c.id] = { ...prev, at, state: 'failed', live, error: (e as Error).message }
        else nextLast[c.id] = { budget: live, at, state: 'failed', live, error: (e as Error).message }
        logger.warn('[budget-schedule] apply failed — will retry next tick', { scheduleId: s.id, campaignId: c.id, error: (e as Error).message })
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
  logger.info('[budget-schedule] tick', { evaluated: schedules.length, changed, yielded, refused })
  return { evaluated: schedules.length, changed, yielded, refused }
}

export async function runBudgetScheduleCron(): Promise<void> {
  // BSP-P3 — the summary carries the refusals too. A green cron row that reports only `changed`
  // reads as "all good" while every write is being stood down: [[reference_cron_success_carries_sweeper_error]].
  try { await recordCronRun('ad-budget-schedule', async () => { const r = await runBudgetScheduleOnce(); return `evaluated=${r.evaluated} changed=${r.changed} yielded=${r.yielded} refused=${r.refused}` }) }
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
