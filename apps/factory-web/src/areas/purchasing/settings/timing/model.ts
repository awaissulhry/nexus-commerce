import { CONFIRM_DAYS, REMINDERS } from '@nexus/factory-domain/purchasing/orders/delivery'
import type { ReminderSettings } from '../api'
import type { Scope } from '../model'
import type { TimingBody } from './api'

/**
 * Purchasing › Settings › Confirmation, the reminders' timing (B-W2b-382, the screen gap B-W2b-377 left; SCM-087): the
 * confirm-by time a send asks by default (hours; empty: the company follows every company's, else W2a's 48 hours over the
 * supplier's open days) and how often the daily run reminds and chases (days; empty: every company's, else every day). Both
 * are the Owner's (purchasing.reminders.switch), on the scope's row (this company's own, or every company's) at its version.
 * The chase of late lines follows the same switch as the confirmation reminders: OFF, the daily run sends neither. PURE.
 */

export const TIMING_LIMITS = Object.freeze({ hours: { min: 1, max: 720 }, days: { min: 1, max: 30 } })
/** W2a's default: two of the supplier's open days; the cadence: every day (REMINDERS.everyHours). */
export const DEFAULT_HOURS = CONFIRM_DAYS * 24
export const DEFAULT_CADENCE_DAYS = REMINDERS.everyHours / 24

export interface TimingDraft {
  /** Typed text; empty: not set on this row. */
  readonly hours: string
  readonly days: string
}

const ownRow = (settings: ReminderSettings, scope: Scope) => (scope === 'company' ? settings.company : settings.tenant)

/** The draft as the scope's row holds it now. */
export function timingDraftOf(settings: ReminderSettings, scope: Scope): TimingDraft {
  const row = ownRow(settings, scope)
  return { hours: row?.confirmByHours != null ? String(row.confirmByHours) : '', days: row?.reminderCadenceDays != null ? String(row.reminderCadenceDays) : '' }
}

const whole = (text: string, min: number, max: number): number | null | 'bad' => {
  const value = text.trim()
  if (value === '') return null
  if (!/^\d{1,4}$/.test(value)) return 'bad'
  const number = Number(value)
  return number >= min && number <= max ? number : 'bad'
}

/** Each field's problem (a key of purchasing-settings), none when both are empty or whole numbers in range. */
export function timingProblems(draft: TimingDraft): { hours?: string; days?: string } {
  return {
    ...(whole(draft.hours, TIMING_LIMITS.hours.min, TIMING_LIMITS.hours.max) === 'bad' ? { hours: 'timing.problem.hours' } : {}),
    ...(whole(draft.days, TIMING_LIMITS.days.min, TIMING_LIMITS.days.max) === 'bad' ? { days: 'timing.problem.days' } : {}),
  }
}

export const timingChanged = (settings: ReminderSettings, scope: Scope, draft: TimingDraft): boolean => {
  const now = timingDraftOf(settings, scope)
  return now.hours !== draft.hours.trim() || now.days !== draft.days.trim()
}

/** What Save sends: both values of the scope's row (null clears one) at the version read. */
export function timingBody(settings: ReminderSettings, draft: TimingDraft, scope: Scope, companyId: string | null): TimingBody {
  const row = ownRow(settings, scope)
  const hours = whole(draft.hours, TIMING_LIMITS.hours.min, TIMING_LIMITS.hours.max)
  const days = whole(draft.days, TIMING_LIMITS.days.min, TIMING_LIMITS.days.max)
  return { companyId: scope === 'company' ? companyId : null, confirmByHours: hours === 'bad' ? null : hours, reminderCadenceDays: days === 'bad' ? null : days, ...(row ? { version: row.version } : {}) }
}

/** Why Save of the timing waits, or null. */
export function timingHeld(settings: ReminderSettings, scope: Scope, draft: TimingDraft, offline: boolean, busy: boolean): string | null {
  if (!settings.mayChange) return scope === 'all' ? 'timing.held.noRightAll' : 'timing.held.noRight'
  if (offline) return 'timing.held.offline'
  if (busy) return 'timing.held.busy'
  if (Object.keys(timingProblems(draft)).length > 0) return 'timing.held.problem'
  return null
}

/** What holds now, in words: the confirm-by and the cadence, each with where it comes from. */
export function timingInForce(settings: ReminderSettings): { hours: { key: string; params: Record<string, number> }; days: { key: string; params: Record<string, number> } } {
  const timing = settings.timing
  const hours = timing?.confirmByHours ?? null
  const cadence = timing?.cadenceDays ?? DEFAULT_CADENCE_DAYS
  return {
    hours: hours === null ? { key: 'timing.inForce.hoursDefault', params: { hours: DEFAULT_HOURS, days: CONFIRM_DAYS } } : { key: `timing.inForce.hours.${timing?.source.confirmByHours ?? 'DEFAULT'}`, params: { hours, count: hours } },
    days: { key: `timing.inForce.days.${timing?.source.cadenceDays ?? 'DEFAULT'}`, params: { days: cadence, count: cadence } },
  }
}

/** The chase in words: ON — the daily run reminds and chases at the cadence; OFF — it sends neither (by hand still goes). */
export const chaseWordsKey = (on: boolean): string => (on ? 'timing.chase.on' : 'timing.chase.off')
