/**
 * The ValidityBar's rules (design part "ValidityBar (new)", 02-sections-quality-compliance: "a validity span with today's marker,
 * the alert thresholds (180 / 90 / 30 days) … and the words ('3 years 4 months left'); mini variant for grid cells"), pure. A
 * compliance area part (B-W2b-266; `compliance/_shared/validity`): the status board's "What expires next" uses it first;
 * certificates, tests, sourcing and the reports may take it as it is. Days are business days (YYYY-MM-DD); nothing here reads a
 * clock: `today` comes from the caller.
 */

/** The alert thresholds before the end, in days (the certificate renewals' 180 / 90 / 30). */
export const VALIDITY_ALERTS = [180, 90, 30] as const

/** Where a validity stands today: in force, inside an alert window, ended. */
export const VALIDITY_STAGES = ['ok', 'd180', 'd90', 'd30', 'ended', 'notYet'] as const
export type ValidityStage = (typeof VALIDITY_STAGES)[number]

const DAY_MS = 24 * 60 * 60 * 1000
const isDay = (value: string | null | undefined): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const utc = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))

/** Whole days from `a` to `b` (negative when `b` is before `a`). */
export const daysBetween = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / DAY_MS)

/** `day` plus `months` calendar months, the day of the month kept or clamped to the month's last day (31 Jan + 1 = 28 Feb). */
function addMonths(day: string, months: number): string {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7)) - 1 + months
  const at = new Date(Date.UTC(year, month, 1))
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate()
  at.setUTCDate(Math.min(Number(day.slice(8, 10)), last))
  return at.toISOString().slice(0, 10)
}

/** Calendar years, months and days from `a` to `b` (b ≥ a), as a person counts them: 10 Nov 2026 → 11 Mar 2030 = 3 years 4 months 1 day; 31 Jan → 1 Mar = 1 month 1 day. */
export function spanParts(a: string, b: string): { years: number; months: number; days: number } {
  if (b < a) return { years: 0, months: 0, days: 0 }
  let months = (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)))
  if (addMonths(a, months) > b) months -= 1
  return { years: Math.floor(months / 12), months: months % 12, days: daysBetween(addMonths(a, months), b) }
}

export interface ValidityInput {
  /** The first valid day; null when not known (the bar then shows the time left only). */
  readonly from: string | null
  /** The last valid day. */
  readonly to: string
  readonly today: string
}

export interface Validity {
  readonly stage: ValidityStage
  /** Days from today to the last valid day (0 = ends today; negative = ended). */
  readonly daysLeft: number
  /** What is left in words' parts (the two largest units are said). */
  readonly left: { readonly years: number; readonly months: number; readonly days: number }
  /** The span in days, when the first day is known. */
  readonly total: number | null
  /** Today on the track, 0–100 (null without a first day). */
  readonly todayAt: number | null
  /** The alert thresholds on the track (only those inside the span), 0–100. */
  readonly alerts: readonly { readonly days: number; readonly at: number }[]
  /** The nearest alert threshold already passed (180, 90, 30), null before the first. */
  readonly alert: number | null
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value))

/** The bar for a span and today. A span with no or a bad first day is drawn as the time left only. */
export function validityOf(input: ValidityInput): Validity {
  const daysLeft = daysBetween(input.today, input.to)
  const from = isDay(input.from) && input.from <= input.to ? input.from : null
  const total = from ? Math.max(1, daysBetween(from, input.to)) : null
  const alert = daysLeft < 0 ? null : (VALIDITY_ALERTS.filter((days) => daysLeft <= days).at(-1) ?? null)
  const stage: ValidityStage = daysLeft < 0 ? 'ended' : from && input.today < from ? 'notYet' : alert === 30 ? 'd30' : alert === 90 ? 'd90' : alert === 180 ? 'd180' : 'ok'
  const todayAt = total && from ? clamp((daysBetween(from, input.today) / total) * 100) : null
  const alerts = total ? VALIDITY_ALERTS.filter((days) => days < total).map((days) => ({ days, at: clamp(((total - days) / total) * 100) })) : []
  return { stage, daysLeft, left: spanParts(input.today, input.to), total, todayAt, alerts, alert }
}

/** The tone a stage is drawn in (always with words beside it, never a colour alone). */
export const STAGE_TONE: Readonly<Record<ValidityStage, 'neutral' | 'info' | 'warning' | 'danger' | 'success'>> = {
  ok: 'success',
  d180: 'info',
  d90: 'warning',
  d30: 'danger',
  ended: 'danger',
  notYet: 'neutral',
}

/**
 * The words of what is left, as message keys with their counts (namespace compliance-status, `validity.*`): the two largest
 * units ("3 years 4 months left"), days alone under a month ("28 days left"), "Ends today", "Ended N days ago".
 */
export function leftWords(validity: Pick<Validity, 'daysLeft' | 'left'>): { key: string; params: Record<string, number> }[] {
  if (validity.daysLeft < 0) return [{ key: 'validity.ended', params: { count: -validity.daysLeft } }]
  if (validity.daysLeft === 0) return [{ key: 'validity.endsToday', params: {} }]
  const { years, months, days } = validity.left
  if (years === 0 && months === 0) return [{ key: 'validity.daysLeft', params: { count: days } }]
  const parts: { key: string; params: Record<string, number> }[] = []
  if (years > 0) parts.push({ key: 'validity.years', params: { count: years } })
  if (months > 0) parts.push({ key: 'validity.months', params: { count: months } })
  if (parts.length < 2 && days > 0) parts.push({ key: 'validity.days', params: { count: days } })
  return parts.slice(0, 2)
}
