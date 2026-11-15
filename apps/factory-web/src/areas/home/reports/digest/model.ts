import { isApiError, issuePath } from '../../../../lib/api/errors'
import { DIGEST_SECTIONS, type Digest, type DigestCompany, type DigestLocale, type DigestPreview, type DigestSection, type DigestSetting, type SaveDigestBody } from './api'

/**
 * The owner digest panel's rules (B-W2b-435; ANA-032; design home.reports `digest`: "Preview of today's digest in Italiano /
 * English … Time (07:30 site time), recipients, language"; Edit opens a small form with the EditModeBar; "Send me a test"), pure.
 * Words are message keys of the `home-digest` catalogue.
 */

export const NAMESPACE = 'home-digest'
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: T }

export interface DigestDraft {
  readonly enabled: boolean
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly locale: DigestLocale
  readonly sections: readonly DigestSection[]
  /** A company, or null: every company I work in (the group digest). */
  readonly companyId: string | null
}

export const draftOf = (setting: DigestSetting): DigestDraft => ({
  enabled: setting.enabled,
  sendTime: setting.sendTime,
  weekdays: [...setting.weekdays],
  locale: setting.locale,
  sections: [...setting.sections],
  companyId: setting.companyId,
})

const same = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length === b.length && a.every((value, index) => value === b[index])

/** How many fields the draft changed from the saved settings (the EditModeBar's "N changes not saved"). */
export function changesOf(draft: DigestDraft, setting: DigestSetting): number {
  let count = 0
  if (draft.enabled !== setting.enabled) count += 1
  if (draft.sendTime !== setting.sendTime) count += 1
  if (!same(draft.weekdays, setting.weekdays)) count += 1
  if (draft.locale !== setting.locale) count += 1
  if (!same(draft.sections, setting.sections)) count += 1
  if (draft.companyId !== setting.companyId) count += 1
  return count
}

/** A day ticked or not (kept in order). */
export const withDay = (days: readonly number[], day: number): number[] => (days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day].sort((a, b) => a - b))

/** A section ticked or not (kept in the design's order). */
export const withSection = (sections: readonly DigestSection[], section: DigestSection): DigestSection[] =>
  sections.includes(section) ? sections.filter((entry) => entry !== section) : DIGEST_SECTIONS.filter((entry) => entry === section || sections.includes(entry))

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** Why Save waits (a message key), or null. */
export function draftHeld(draft: DigestDraft, changes: number): string | null {
  if (changes === 0) return 'digest.held.nothing'
  if (!TIME.test(draft.sendTime)) return 'digest.held.time'
  if (draft.weekdays.length === 0) return 'digest.held.days'
  if (draft.sections.length === 0) return 'digest.held.sections'
  return null
}

export const saveBodyOf = (draft: DigestDraft, version: number): SaveDigestBody => ({ ...draft, weekdays: [...draft.weekdays], sections: [...draft.sections], version })

/** The companies a digest covers, by name (a group digest: every one I work in). */
export function coveredCompanies(digest: Digest, companyId: string | null): DigestCompany[] {
  return companyId ? digest.companies.filter((company) => company.id === companyId) : [...digest.companies]
}

/** Why my digest would not go out now, as a message key, or null: it goes out. */
export const heldKey = (held: Digest['held']): string | null => (held === 'OFF' ? 'digest.held.off' : held === 'MAIL_OFF' ? 'digest.held.mailOff' : null)

/** "Mon–Fri" style words: the days in order, or a known group. */
export function daysWords(days: readonly number[], t: (key: string) => string): string {
  if (same(days, [1, 2, 3, 4, 5])) return t('digest.days.workdays')
  if (same(days, [1, 2, 3, 4, 5, 6, 7])) return t('digest.days.every')
  return days.map((day) => t(`digest.day.${day}`)).join(', ')
}

/** Who gets the morning e-mail of the companies I hold the switch of: one row per person and company. */
export function recipientRows(digest: Digest): { readonly companyId: string; readonly company: string; readonly id: string; readonly name: string; readonly me: boolean; readonly group: boolean; readonly sendTime: string; readonly locale: DigestLocale }[] {
  return digest.companies.flatMap((company) => (company.recipients ?? []).map((person) => ({ companyId: company.id, company: company.name, ...person })))
}

/** The preview's sections that are left out because of the reader's rights. */
export const leftOut = (preview: DigestPreview): DigestSection[] => preview.sections.filter((entry) => entry.state === 'NO_ACCESS').map((entry) => entry.section)

/** A failed read as a message key. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'digest.error.read'
  if (error.kind === 'forbidden') return 'digest.error.forbidden'
  if (error.kind === 'unavailable') return 'digest.error.offline'
  return 'digest.error.read'
}

/** A refused save, switch or test as a message key. */
export function writeProblem(error: unknown): string {
  if (!isApiError(error)) return 'digest.error.save'
  const paths = error.issues.map(issuePath)
  if (paths.includes('digest/MAIL_OFF')) return 'digest.error.mailOff'
  if (paths.includes('digest/NOT_SENT')) return 'digest.error.notSent'
  if (error.kind === 'conflict') return 'digest.error.stale'
  if (error.kind === 'forbidden') return 'digest.error.forbidden'
  if (error.kind === 'unavailable') return 'digest.error.offline'
  if (paths.some((path) => path.startsWith('body'))) return 'digest.error.invalid'
  return 'digest.error.save'
}
