import type { Issue } from '../core/errors'
import { businessDate, businessDayStart, type BusinessDate } from '../core/time'

/**
 * Restore drills (B-W2a-36; PLT-214 "a restore drill must be proven, not assumed"; design admin.security "Backups and
 * restore drills" with its popup "Record a restore drill"), pure. The backups themselves live at the database provider
 * and, with the Owner's yes, at a second EU provider (B-W0-32, GATE-SPEND); here is what proves one can come back:
 *
 *   1. a person restores a backup somewhere other than production (a local copy, staging);
 *   2. on the restored copy, Security & health shows the copy's FINGERPRINT as of the backup's time: per key record list
 *      (orders, invoices, stock moves, parties, files) a checksum of the rows that existed then — their count and their
 *      ids (stock moves with their quantities, files with their content hash: columns that never change once written)
 *      — never a money figure, never a name;
 *   3. back on the real system, "Record a restore drill" takes the copy's fingerprint line, the API works out the same
 *      fingerprint of THIS database at the same time and compares: PASSED only when every key matches (the database
 *      refuses a PASSED drill with a mismatch too). The drill is append-only evidence, optionally with its file (the
 *      restore log, a screenshot): a mistake is a new drill.
 *
 * A drill is due every DRILL_INTERVAL_DAYS after the last one that PASSED; the reminder (a DueTimer
 * `RESTORE_DRILL_DUE:-14d` on the Tenant) fires DRILL_REMIND_DAYS before, and All settings › Needs attention says so from
 * then on.
 */

/** The key record lists a fingerprint covers, in the order a line names them. */
export const DRILL_KEYS = ['orders', 'invoices', 'stockMoves', 'parties', 'files'] as const
export type DrillKey = (typeof DRILL_KEYS)[number]

/** What each key covers, in words (the API's tables). */
export const DRILL_KEY_COVERS: Readonly<Record<DrillKey, string>> = Object.freeze({
  orders: 'Sales orders: their count and ids.',
  invoices: 'Invoices and credit notes: their count and ids.',
  stockMoves: 'Stock moves: their count, ids and quantities (no money in a checksum).',
  parties: 'Customers and suppliers: their count and ids.',
  files: 'Stored files: their count, ids and content hashes.',
})

/** A checksum as a fingerprint shows it: 16 lower-case hex characters. */
export const CHECKSUM = /^[0-9a-f]{16}$/

/** The fingerprint line's prefix (its version: a change of what a key covers is a new prefix). */
export const FINGERPRINT_PREFIX = 'NXF1'

export const DRILL_INTERVAL_DAYS = 90
export const DRILL_REMIND_DAYS = 14
export const DRILL_TIMER_KIND = 'RESTORE_DRILL_DUE'
/** The DueTimer's key (B-W2a-33's `KIND[:±N(m|h|d)]`): fires DRILL_REMIND_DAYS before the drill is due. */
export const DRILL_TIMER_KEY = `${DRILL_TIMER_KIND}:-${DRILL_REMIND_DAYS}d`

export type Fingerprint = Readonly<Record<DrillKey, string>>

/** The line a person copies from the restored copy: `NXF1 orders=… invoices=… stockMoves=… parties=… files=…`. */
export function fingerprintLine(fingerprint: Fingerprint): string {
  return [FINGERPRINT_PREFIX, ...DRILL_KEYS.map((key) => `${key}=${fingerprint[key]}`)].join(' ')
}

/** A pasted fingerprint line read back; the issues name what is wrong with it (path `restored`). */
export function parseFingerprint(text: string): { readonly fingerprint: Fingerprint | null; readonly issues: Issue[] } {
  const at = (message: string) => ({ fingerprint: null, issues: [{ path: 'restored', message }] })
  const parts = text.trim().split(/[\s;,]+/).filter((part) => part !== '')
  if (parts.length === 0) return at("Paste the restored copy's fingerprint line.")
  if (parts[0] !== FINGERPRINT_PREFIX) return at(`A fingerprint line starts with ${FINGERPRINT_PREFIX}: copy it from the restored copy's Security & health page.`)
  const found = new Map<string, string>()
  for (const part of parts.slice(1)) {
    const [key, value, ...rest] = part.split('=')
    if (key === undefined || value === undefined || rest.length > 0) return at(`"${part}" is not a key=checksum pair.`)
    if (!(DRILL_KEYS as readonly string[]).includes(key)) return at(`"${key}" is not a key of a fingerprint.`)
    if (found.has(key)) return at(`"${key}" is named twice.`)
    if (!CHECKSUM.test(value.toLowerCase())) return at(`The checksum of "${key}" is 16 hex characters.`)
    found.set(key, value.toLowerCase())
  }
  const missing = DRILL_KEYS.filter((key) => !found.has(key))
  if (missing.length > 0) return at(`The line misses ${missing.join(', ')}.`)
  return { fingerprint: Object.freeze(Object.fromEntries(DRILL_KEYS.map((key) => [key, found.get(key)!]))) as Fingerprint, issues: [] }
}

/** One compared key, as a drill keeps it (checksums only). */
export interface DrillCheck {
  readonly key: DrillKey
  readonly source: string
  readonly restored: string
  readonly match: boolean
}

export type DrillResult = 'PASSED' | 'FAILED'

/** This database's fingerprint beside the restored copy's, key by key. */
export function compareFingerprints(source: Fingerprint, restored: Fingerprint): DrillCheck[] {
  return DRILL_KEYS.map((key) => ({ key, source: source[key], restored: restored[key], match: source[key] === restored[key] }))
}

/** PASSED only when there are checks and every one matches. */
export function drillResultOf(checks: readonly Pick<DrillCheck, 'match'>[]): DrillResult {
  return checks.length > 0 && checks.every((check) => check.match) ? 'PASSED' : 'FAILED'
}

/** Words that name production: a drill restores somewhere else, never over production. */
const PRODUCTION = /\b(prod|production|produzione|live)\b/i

export interface DrillInput {
  readonly drilledOn: BusinessDate
  readonly environment: string
  readonly backupAt: Date
  readonly durationMinutes?: number | null
  readonly notes?: string | null
}

/** What is wrong with a drill as typed (paths name the body fields). */
export function drillProblems(input: DrillInput, now: Date): Issue[] {
  const issues: Issue[] = []
  const today = businessDate(now)
  if (input.drilledOn > today) issues.push({ path: 'drilledOn', message: 'A drill is recorded once it was done: the day cannot be in the future.' })
  if (input.backupAt.getTime() > now.getTime()) issues.push({ path: 'backupAt', message: 'The backup restored cannot be from the future.' })
  if (businessDate(input.backupAt) > input.drilledOn) issues.push({ path: 'backupAt', message: 'The backup restored is from before the day of the drill.' })
  const environment = input.environment.trim()
  if (environment === '' || environment.length > 120) issues.push({ path: 'environment', message: 'Say where the backup was restored (1 to 120 characters).' })
  else if (PRODUCTION.test(environment)) issues.push({ path: 'environment', message: 'A drill restores a backup somewhere other than production (a local copy, staging), never over it.' })
  if (input.durationMinutes != null && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 0 || input.durationMinutes > 10_080)) {
    issues.push({ path: 'durationMinutes', message: 'Minutes from 0 to 10080 (a week).' })
  }
  if (input.notes != null && input.notes.length > 2000) issues.push({ path: 'notes', message: 'At most 2000 characters.' })
  return issues
}

/** The business date N calendar days from a date (negative: before). */
export function plusDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const at = (date: BusinessDate) => {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number]
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((at(to) - at(from)) / 86_400_000)
}

/** The day the next drill is due after a drill that passed. */
export const drillDueOn = (lastPassedOn: BusinessDate): BusinessDate => plusDays(lastPassedOn, DRILL_INTERVAL_DAYS)

/**
 * The restore drill's state for the status line and the attention list:
 *   none      no drill recorded yet (needs a person)
 *   failed    the last drill failed (needs a person: find out why, drill again)
 *   overdue   the last passed drill is older than the interval
 *   due_soon  it falls due within DRILL_REMIND_DAYS
 *   ok        otherwise
 */
export type DrillState = 'none' | 'failed' | 'overdue' | 'due_soon' | 'ok'

export interface DrillStatus {
  readonly state: DrillState
  /** The last drill's day, whatever its result; null: none. */
  readonly lastOn: BusinessDate | null
  readonly lastResult: DrillResult | null
  /** Days since the last drill. */
  readonly daysAgo: number | null
  /** When the next one is due (after the last that passed); null when none passed yet. */
  readonly dueOn: BusinessDate | null
  /** Days left until it is due (negative: overdue). */
  readonly daysLeft: number | null
}

export function drillStatus(drills: readonly { readonly drilledOn: BusinessDate; readonly result: DrillResult; readonly createdAt: Date }[], now: Date): DrillStatus {
  const today = businessDate(now)
  const ordered = [...drills].sort((a, b) => (a.drilledOn === b.drilledOn ? b.createdAt.getTime() - a.createdAt.getTime() : a.drilledOn < b.drilledOn ? 1 : -1))
  const last = ordered[0]
  if (!last) return { state: 'none', lastOn: null, lastResult: null, daysAgo: null, dueOn: null, daysLeft: null }
  const passed = ordered.find((drill) => drill.result === 'PASSED')
  const dueOn = passed ? drillDueOn(passed.drilledOn) : null
  const daysLeft = dueOn === null ? null : daysBetween(today, dueOn)
  const state: DrillState =
    last.result === 'FAILED' ? 'failed' : daysLeft !== null && daysLeft < 0 ? 'overdue' : daysLeft !== null && daysLeft <= DRILL_REMIND_DAYS ? 'due_soon' : 'ok'
  return { state, lastOn: last.drilledOn, lastResult: last.result, daysAgo: daysBetween(last.drilledOn, today), dueOn, daysLeft }
}

/** The reminder a drill that passed sets: due on `drillDueOn`, firing DRILL_REMIND_DAYS before (start of day, Rome). */
export function drillTimerOf(drilledOn: BusinessDate): { readonly timerKey: string; readonly dueAt: Date; readonly fireAt: Date; readonly dueOn: BusinessDate } {
  const dueOn = drillDueOn(drilledOn)
  return { timerKey: DRILL_TIMER_KEY, dueOn, dueAt: businessDayStart(dueOn), fireAt: businessDayStart(plusDays(dueOn, -DRILL_REMIND_DAYS)) }
}
