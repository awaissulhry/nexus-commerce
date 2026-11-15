/**
 * Scheduled jobs (B-W2b-415; PLT-221; design admin.security sec:jobs, pop:run-now), pure: the next run of a cron schedule
 * in its time zone, a job's state from its runs, and why Run now is held. The API and the web share them.
 *
 * A schedule is a node-cron expression (apps/factory-api core/cron.ts): 5 fields (minute hour day month weekday) or 6 (a
 * second first). Each field: `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, or a list of those. Weekday 0-7 (0 and 7
 * are Sunday). When both day of month and weekday are restricted a day matches either (as cron does).
 */

export interface CronFields {
  readonly seconds: ReadonlySet<number>
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly weekdays: ReadonlySet<number>
  readonly daysRestricted: boolean
  readonly weekdaysRestricted: boolean
}

export class CronScheduleError extends Error {
  override name = 'CronScheduleError'
}

function field(text: string, min: number, max: number, what: string): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined]
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new CronScheduleError(`${what}: "${part}" has a bad step`)
    let from = min
    let to = max
    if (range !== '*') {
      const [a, b] = range.split('-') as [string, string | undefined]
      from = Number(a)
      to = b === undefined ? (stepText === undefined ? from : max) : Number(b)
      if (!/^\d+$/.test(a) || (b !== undefined && !/^\d+$/.test(b))) throw new CronScheduleError(`${what}: "${part}" is not a number or a range`)
    }
    if (from < min || to > max || from > to) throw new CronScheduleError(`${what}: "${part}" is outside ${min}-${max}`)
    for (let value = from; value <= to; value += step) out.add(value)
  }
  return out
}

/** Reads a 5- or 6-field schedule; throws CronScheduleError on anything else. */
export function parseCron(schedule: string): CronFields {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) throw new CronScheduleError(`"${schedule}" has ${parts.length} fields (5 or 6)`)
  const [sec, min, hour, day, month, weekday] = parts.length === 6 ? parts : ['0', ...parts]
  const weekdays = field(weekday!, 0, 7, 'weekday')
  if (weekdays.has(7)) weekdays.add(0)
  weekdays.delete(7)
  return {
    seconds: field(sec!, 0, 59, 'second'),
    minutes: field(min!, 0, 59, 'minute'),
    hours: field(hour!, 0, 23, 'hour'),
    days: field(day!, 1, 31, 'day'),
    months: field(month!, 1, 12, 'month'),
    weekdays,
    daysRestricted: day !== '*',
    weekdaysRestricted: weekday !== '*',
  }
}

const WEEKDAY: Readonly<Record<string, number>> = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })
const formatters = new Map<string, Intl.DateTimeFormat>()

interface Wall {
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: number
}

function wallOf(instant: number, timeZone: string): Wall {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
    formatters.set(timeZone, format)
  }
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(new Date(instant))) parts[part.type] = part.value
  return { month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAY[parts.weekday!] ?? 0 }
}

function dayMatches(fields: CronFields, wall: Wall): boolean {
  if (!fields.months.has(wall.month)) return false
  const byDay = fields.days.has(wall.day)
  const byWeekday = fields.weekdays.has(wall.weekday)
  if (fields.daysRestricted && fields.weekdaysRestricted) return byDay || byWeekday
  return byDay && byWeekday
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

/**
 * The first moment strictly after `after` that the schedule fires, in its time zone; null when none within `withinDays`
 * (default 400). Walks minute by minute, skipping whole hours and days that cannot match, so a daily job costs a few
 * dozen steps.
 */
export function nextRunOf(schedule: string | CronFields, timeZone: string, after: Date, withinDays = 400): Date | null {
  const fields = typeof schedule === 'string' ? parseCron(schedule) : schedule
  const limit = after.getTime() + withinDays * 24 * 60 * MINUTE
  const start = after.getTime() + SECOND
  let t = Math.floor(start / MINUTE) * MINUTE
  const seconds = [...fields.seconds].sort((a, b) => a - b)
  while (t <= limit) {
    const wall = wallOf(t, timeZone)
    if (!dayMatches(fields, wall)) {
      t += ((23 - wall.hour) * 60 + (60 - wall.minute)) * MINUTE
      continue
    }
    if (!fields.hours.has(wall.hour)) {
      t += (60 - wall.minute) * MINUTE
      continue
    }
    if (fields.minutes.has(wall.minute)) {
      for (const second of seconds) {
        const at = t + second * SECOND
        if (at >= start) return new Date(at)
      }
    }
    t += MINUTE
  }
  return null
}

/** A run as the jobs page reads it. */
export interface RunFacts {
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  readonly trigger: 'SCHEDULE' | 'RUN_NOW'
  readonly scheduledAt: Date
  readonly startedAt: Date
}

export const JOB_STATES = ['ok', 'running', 'stuck', 'failing', 'missed', 'never'] as const
export type JobState = (typeof JOB_STATES)[number]

/** A run still RUNNING after this long is stuck (no job of the factory takes that long). */
export const STUCK_AFTER_MS = 30 * MINUTE
/** A tick is missed when no run was recorded this long after it was due. */
export const MISSED_AFTER_MS = 5 * MINUTE

/**
 * A job's state: stuck (a run RUNNING longer than STUCK_AFTER_MS), running, failing (its latest finished run FAILED),
 * missed (a tick after the latest scheduled run passed MISSED_AFTER_MS ago with no run), never (no run recorded yet),
 * else ok. `last` is the latest run of any trigger, `lastScheduled` the latest SCHEDULE run.
 */
export function jobStateOf(input: { readonly schedule: string; readonly timeZone: string; readonly last: RunFacts | null; readonly lastFinished: RunFacts | null; readonly lastScheduled: RunFacts | null; readonly now: Date }): JobState {
  const { last, now } = input
  if (!last) return 'never'
  if (last.status === 'RUNNING') return now.getTime() - last.startedAt.getTime() > STUCK_AFTER_MS ? 'stuck' : 'running'
  if (missedTickOf(input) !== null) return 'missed'
  if (input.lastFinished?.status === 'FAILED') return 'failing'
  return 'ok'
}

/** The first tick after the latest scheduled run that has no run though it was due MISSED_AFTER_MS ago; else null. */
export function missedTickOf(input: { readonly schedule: string; readonly timeZone: string; readonly lastScheduled: RunFacts | null; readonly now: Date }): Date | null {
  if (!input.lastScheduled) return null
  const next = nextRunOf(input.schedule, input.timeZone, input.lastScheduled.scheduledAt)
  return next && next.getTime() + MISSED_AFTER_MS < input.now.getTime() ? next : null
}

/** Why Run now is held, as a code (the web says it in words). */
export const RUN_NOW_HELD = ['UNKNOWN_JOB', 'SCHEDULE_ONLY', 'SWITCHED_OFF', 'ASKED'] as const
export type RunNowHeld = (typeof RUN_NOW_HELD)[number]

/** How each job may be run now: `check` (it checks or catches up: an early run changes nothing the next tick would not) or `schedule` (it acts at a set time, or sends). */
export type RunNowPolicy = 'check' | 'schedule'

/** Whether Run now may ask the job: null, or why not. `switchedOn` null: the job waits for no switch. */
export function runNowHeldOf(input: { readonly known: boolean; readonly policy: RunNowPolicy | null; readonly switchedOn: boolean | null; readonly asked: boolean }): RunNowHeld | null {
  if (!input.known || input.policy === null) return 'UNKNOWN_JOB'
  if (input.policy === 'schedule') return 'SCHEDULE_ONLY'
  if (input.switchedOn === false) return 'SWITCHED_OFF'
  if (input.asked) return 'ASKED'
  return null
}

/** The RUN_NOW run's key (factory-db: `<jobKey>@now:<request>`). */
export function runNowKeyOf(jobKey: string, requestId: string): string {
  return `${jobKey}@now:${requestId}`
}

/** The SCHEDULE run's key (factory-db: `<jobKey>@<the tick's epoch seconds>`). */
export function tickKeyOf(jobKey: string, scheduledAt: Date): string {
  return `${jobKey}@${Math.floor(scheduledAt.getTime() / 1000)}`
}

/** A run's error as the database keeps it: one message, 1 to 4000 characters (never empty). */
export function runErrorOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : 'The job failed without a message.'
  const line = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim()
  return (line === '' ? 'The job failed without a message.' : line).slice(0, 4000)
}
