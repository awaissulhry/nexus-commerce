/**
 * Platform health watchdog (2026-10-07) — the shape of one check.
 *
 * A check watches ONE part of the platform and is made of two halves:
 *   gather   reads Nexus's own records (CronRun, the feed tables, AdMutation, AgentPlanStep, the process heartbeats …)
 *            into plain facts — the only half that touches the database;
 *   judge    pure: facts + the clock → a verdict (ok | warn | fail | unknown), what is wrong in plain words, the likely
 *            cause, the next step, and the numbers it rests on. Tested with fixture facts, healthy and failing.
 *
 * `unknown` is "could not measure" and says why. It is never ok, and it raises no alert: an alert must name something
 * that was measured. A gather that throws is reported as unknown with its error by the runner, never swallowed.
 *
 * Evidence holds counts, dates, ids and names only — never money, never a buyer's data: Claude and the alert e-mail read
 * it as it is.
 */

export const CHECK_STATUSES = ['ok', 'warn', 'fail', 'unknown'] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]

export const SUBSYSTEMS = ['scheduler', 'data-feeds', 'channel-writes', 'approvals', 'automation', 'queues'] as const
export type Subsystem = (typeof SUBSYSTEMS)[number]

/** A verdict, without the check's identity (the runner adds it). */
export interface Verdict {
  status: CheckStatus
  /** What is wrong, or that all is well, in plain words. */
  message: string
  likelyCause: string | null
  nextStep: string | null
  /** The numbers the verdict rests on. */
  evidence: Record<string, unknown>
}

export interface CheckResult extends Verdict {
  id: string
  subsystem: Subsystem
  title: string
}

/** What every gather is handed: the clock, and a memo so two checks reading the same rows read them once. */
export interface CheckContext {
  now: Date
  memo<T>(key: string, read: () => Promise<T>): Promise<T>
}

export interface HealthCheck<F = unknown> {
  /** Stable id: the alert rule's metric is `platformHealth:<id>`. Never rename one: its open alert would be orphaned. */
  id: string
  subsystem: Subsystem
  /** A short name: the alert rule is "Platform health: <title>". */
  title: string
  /** What it watches, one sentence: the alert rule's description. */
  watches: string
  gather(ctx: CheckContext): Promise<F>
  judge(facts: F, now: Date): Verdict
}

/** A check of any facts, as the registry lists them (each check keeps its own facts type). */
export type AnyHealthCheck = HealthCheck<any>

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const MINUTE = 60_000

/** The status of several parts: the worst one (unknown only when nothing was measured). */
export function worst(statuses: readonly CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail'
  if (statuses.includes('warn')) return 'warn'
  if (statuses.includes('ok')) return 'ok'
  return 'unknown'
}

/** Whole UTC days between a date-only day (YYYY-MM-DD or a Date at midnight UTC) and now. */
export function daysBehind(day: Date | string | null, now: Date): number | null {
  if (day == null) return null
  const iso = typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10)
  const at = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(at)) return null
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.max(0, Math.round((today - at) / DAY))
}

export const isoDay = (day: Date | string | null): string | null =>
  day == null ? null : typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10)

/** "HH:MM UTC" of a moment. */
export const clockUtc = (at: Date | string) => `${new Date(at).toISOString().slice(11, 16)} UTC`

/** Numbers in free text become '#': a reason or an error may carry a bid or a price (never money in evidence). */
export const withoutNumbers = (text: string | null | undefined, max = 160): string =>
  (text ?? '').replace(/\d+([.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, max)

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
