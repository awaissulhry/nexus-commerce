/**
 * BP.P2 (2026-08-21) — a builder rule's stored schedule, HONOURED.
 *
 * Every builder rule stores `actions[0].schedule` ({ frequency, everyN, interval, onDay, time,
 * timezone }) and until now NOTHING read it: the adapter drops it at translation and the
 * evaluator ran every rule on its 15-minute cron — so the builder's Frequency and Timezone selects
 * were controls whose value changed no behaviour, while the grid printed the stored schedule as
 * fact. This module is the reader that makes both honest. It gates WHICH rules evaluate on a
 * given tick (`applyMarketplaceScope` filters through `scheduleIsDue`); engine-native rules
 * store no schedule and are untouched.
 *
 * Semantics — stated, simple, testable:
 *  · no schedule / unknown frequency → always due (the engine cadence, exactly as before)
 *  · Hourly → due when the last evaluation is ≥55 minutes old (or has never happened)
 *  · Daily / Weekly / Monthly / Custom → due when, in the rule's OWN timezone:
 *      – today's fire time (HH:mm) has passed, and
 *      – the rule has not evaluated since that fire time, and
 *      – at least (interval − half a day) has passed since the last evaluation
 *        (Daily 1d · Weekly 7d · Monthly 30d · Custom = everyN × Days/Weeks/Months), and
 *      – for Custom-Weeks with a chosen day: today IS that weekday.
 *    The cron ticks every 15 minutes, so a due rule fires within 15 minutes of its stored time.
 *  · a rule that has NEVER evaluated is due immediately — the first check runs on the next tick
 *    after creation (fast feedback for a fresh rule), and every later run follows the schedule.
 *
 * ⚠ The clock read is `lastEvaluatedAt`, which `evaluateRule` advances on EVERY run — including
 * a manual Simulate, so simulating a rule after its fire time absorbs that day's scheduled run.
 * A dedicated column would remove the caveat and is deliberately NOT added: migrations are
 * frozen while RPT's `20260820d` sits unapplied (the W1 law). Revisit when that ships.
 */

export interface StoredRuleSchedule {
  frequency?: string
  everyN?: string | number
  interval?: string
  onDay?: string
  time?: string
  timezone?: string
}

/** The schedule a rule stores, or null (engine-native rules, malformed actions). */
export function ruleStoredSchedule(actions: unknown): StoredRuleSchedule | null {
  const a0 = Array.isArray(actions) ? (actions[0] as { schedule?: unknown } | undefined) : undefined
  const s = a0?.schedule
  return s && typeof s === 'object' ? (s as StoredRuleSchedule) : null
}

/** Builder timezone keys → IANA. Unknown keys fall back to the account's operating timezone. */
const TZ: Record<string, string> = {
  pst: 'America/Los_Angeles',
  est: 'America/New_York',
  utc: 'UTC',
  cet: 'Europe/Rome',
}
const FALLBACK_TZ = 'Europe/Rome'

const DAY_MS = 86_400_000

interface TzParts {
  /** "2026-01-15" in the target timezone — string-comparable. */
  ymd: string
  /** minutes since that timezone's midnight */
  minutes: number
  /** "Monday" … "Sunday" in the target timezone */
  weekday: string
}

function tzParts(d: Date, tz: string): TzParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'long',
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: p.weekday,
  }
}

/** The schedule's interval in days; null means "not an interval cadence" (Hourly, unknown). */
function intervalDays(s: StoredRuleSchedule): number | null {
  const f = String(s.frequency ?? '')
  if (f === 'Daily') return 1
  if (f === 'Weekly') return 7
  if (f === 'Monthly') return 30
  if (f === 'Custom') {
    const n = Math.max(1, Math.round(Number(s.everyN)) || 1)
    const unit = String(s.interval ?? 'Days')
    return n * (unit === 'Weeks' ? 7 : unit === 'Months' ? 30 : 1)
  }
  return null
}

/**
 * Whether a rule with this schedule should evaluate NOW.
 *
 * Pure — the caller supplies the clock — so the contract above is pinned by tests rather than
 * by reading the cron's behaviour back out of production.
 */
export function scheduleIsDue(
  schedule: StoredRuleSchedule | null | undefined,
  lastEvaluatedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!schedule) return true
  const f = String(schedule.frequency ?? '')

  if (f === 'Hourly') {
    return lastEvaluatedAt == null || now.getTime() - lastEvaluatedAt.getTime() >= 55 * 60_000
  }

  const interval = intervalDays(schedule)
  if (interval == null) return true // unknown frequency — never silently stall a rule
  if (lastEvaluatedAt == null) return true // first evaluation runs on the next tick

  const tz = TZ[String(schedule.timezone ?? '')] ?? FALLBACK_TZ
  const nowP = tzParts(now, tz)
  const lastP = tzParts(lastEvaluatedAt, tz)

  // today's fire time must have passed…
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(schedule.time ?? '00:00'))
  const fireMinutes = m ? Number(m[1]) * 60 + Number(m[2]) : 0
  if (nowP.minutes < fireMinutes) return false

  // …the rule must not have evaluated since it…
  if (lastP.ymd === nowP.ymd && lastP.minutes >= fireMinutes) return false

  // …the interval must have elapsed (half-day slack absorbs DST shifts and cron jitter)…
  if (now.getTime() - lastEvaluatedAt.getTime() < (interval - 0.5) * DAY_MS) return false

  // …and a Custom-Weeks schedule with a chosen day fires only on that weekday.
  if (f === 'Custom' && String(schedule.interval ?? '') === 'Weeks' && schedule.onDay) {
    if (nowP.weekday !== String(schedule.onDay)) return false
  }
  return true
}
