import { lengthProblems, lengthsWiden, type SessionLengths } from '@nexus/factory-domain/auth/sessions/lengths'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Translate } from '../../../../lib/i18n/messages'
import type { SecuritySettings } from './api'

/**
 * Admin › Security › Session lengths (SCR-166 section `sessions`, B-W2b-413; design admin.security "Per audience (PLT-068)":
 * "Office: idle 8 h, longest 7 days · Floor: idle 10 min (site setting), ends at shift end · Portal: idle 30 min"; "Longer =
 * wider: fresh code"), pure: the draft, what changed, what is wrong (factory-domain's own rules), whether it widens, a length
 * in words, and a refusal in the page's words. Words: `admin-security-depth` (`lengths.*`, `dur.*`).
 */

export const LENGTH_FIELDS = ['officeIdleMinutes', 'officeLongestHours', 'portalIdleMinutes', 'portalLongestHours'] as const
export type LengthField = (typeof LENGTH_FIELDS)[number]
export type LengthsDraft = SessionLengths

/** The lengths in force, as a draft. */
export function lengthsOf(settings: SecuritySettings): LengthsDraft {
  return {
    officeIdleMinutes: settings.sessions.office.idleMinutes,
    officeLongestHours: settings.sessions.office.longestHours,
    portalIdleMinutes: settings.sessions.portal.idleMinutes,
    portalLongestHours: settings.sessions.portal.longestHours,
  }
}

/** How many fields differ from what is in force. */
export const lengthChanges = (settings: SecuritySettings, draft: LengthsDraft): number => {
  const now = lengthsOf(settings)
  return LENGTH_FIELDS.filter((field) => draft[field] !== now[field]).length
}

/** Longer = wider: saving asks for a fresh code (factory-domain `lengthsWiden`, the API's own rule). */
export const lengthsWider = (settings: SecuritySettings, draft: LengthsDraft): boolean => lengthsWiden(lengthsOf(settings), draft)

/** What is wrong with the draft, field → message key (factory-domain `lengthProblems`: range, idle longer than longest). */
export function lengthErrors(draft: LengthsDraft): Partial<Record<LengthField, string>> {
  const errors: Partial<Record<LengthField, string>> = {}
  for (const issue of lengthProblems(draft)) {
    const [, field, code] = issue.path.split('/')
    if (field && (LENGTH_FIELDS as readonly string[]).includes(field) && !errors[field as LengthField]) errors[field as LengthField] = `lengths.error.${code}`
  }
  return errors
}

/** A length in words ("8 hours", "7 days", "1 hour 30 minutes"), from minutes. */
export function durationWords(minutes: number, t: Translate): string {
  if (minutes > 0 && minutes % 1440 === 0) return t('dur.days', { count: minutes / 1440 })
  if (minutes > 0 && minutes % 60 === 0) return t('dur.hours', { count: minutes / 60 })
  if (minutes > 60) return t('dur.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  return t('dur.minutes', { count: minutes })
}

/** A refused save in words: field errors from `body/<field>/<code>`, else a notice key (409 read again, 403 no right …). */
export function settingsRefusal(error: unknown): { notice: string; fields: Record<string, string> } {
  if (!isApiError(error)) return { notice: 'settings.problem.failed', fields: {} }
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const match = /^body\/([A-Za-z]+)(?:\/\d+)?\/([A-Za-z]+)$/.exec(issuePath(issue))
    if (match && !fields[match[1]!]) fields[match[1]!] = match[2]!
  }
  if (error.kind === 'invalid') return { notice: 'settings.problem.invalid', fields }
  if (error.kind === 'conflict') return { notice: 'settings.problem.stale', fields }
  if (error.kind === 'forbidden') return { notice: 'settings.problem.forbidden', fields }
  if (error.kind === 'unavailable') return { notice: 'settings.problem.unavailable', fields }
  return { notice: 'settings.problem.failed', fields }
}
