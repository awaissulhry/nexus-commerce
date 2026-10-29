import { createHash } from 'node:crypto'
import type { Issue } from '../core/errors'

/**
 * Privacy notices (B-W1-36; A2 SCR-025, SCR-086; PLAN §2.8; GDPR art. 13 and 14; Statuto dei Lavoratori, L. 300/1970,
 * art. 4 c.3; features PLT-208, MES-277, GAP-005; Q15): the rules, pure. factory-db's privacy.prisma holds the notices,
 * the …_privacy_guards triggers hold the same rules for every login.
 *
 *   - three kinds per company: the worker notice (what the floor tools record, shown on the tablet before the first
 *     scan), the staff notice (what the system keeps about office staff, shown once at sign-in) and the public notice
 *     (for everyone outside the company, at `/privacy/<company id>`);
 *   - a version is written as a DRAFT, PUBLISHED (in force: one per company and kind) and SUPERSEDED when a later one is
 *     published; publishing freezes its languages and their fingerprints;
 *   - each language is the text shown (Italian and English screens, Q15) and/or its PDF (the worker notice in each
 *     worker's language, Q15); every notice has an Italian text, a worker notice an English one too;
 *   - the fingerprint of what is shown is the SHA-256 of the text (UTF-8), else of the PDF: an acknowledgement stores
 *     it, so it names exactly what the person saw;
 *   - a person reads their language; without it, Italian, then English (the design's "your language is not ready"
 *     state: HR hands out the PDF of that language).
 * The texts are the company's privacy consultant's; the seeds and tests hold made-up samples only.
 */

export const NOTICE_KINDS = ['WORKER_FLOOR', 'OFFICE_STAFF', 'PRIVACY_PUBLIC'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export const NOTICE_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]

export const isNoticeKind = (value: unknown): value is NoticeKind => (NOTICE_KINDS as readonly unknown[]).includes(value)

/** Each kind in words, for lists and refusals. */
export const NOTICE_KIND_WORDS: Readonly<Record<NoticeKind, string>> = Object.freeze({
  WORKER_FLOOR: 'the worker notice (what the floor tools record)',
  OFFICE_STAFF: 'the staff notice (what the system keeps about office staff)',
  PRIVACY_PUBLIC: 'the public privacy notice',
})

/** The screens' languages (Q15): Italian and English. Other languages are PDFs. */
export const SCREEN_LANGUAGES = ['it', 'en'] as const

/** The languages a version needs as text before it is published: Italian, and English too for the worker notice. */
export function requiredLanguages(kind: NoticeKind): readonly string[] {
  return kind === 'WORKER_FLOOR' ? ['it', 'en'] : ['it']
}

export const LABEL_MAX = 40
export const BODY_MAX = 50_000
const LOCALE = /^[a-z]{2}$/
const SHA256 = /^[0-9a-f]{64}$/

export const isLocale = (value: unknown): value is string => typeof value === 'string' && LOCALE.test(value)
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)

/** The text as stored and shown: line ends as `\n`, no trailing blanks at the end. Its fingerprint is of this. */
export function normaliseNoticeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/\s+$/u, '')
}

/** SHA-256 (lower-case hex) of the text as UTF-8: the fingerprint an acknowledgement stores. */
export function noticeFingerprint(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** The label of version `versionNo` when the office gives none. */
export const defaultLabel = (versionNo: number): string => `v${versionNo}`

/** The next version number of a company's notices of one kind. */
export function nextVersionNo(existing: readonly number[]): number {
  return existing.reduce((max, value) => Math.max(max, value), 0) + 1
}

export function labelProblems(label: string, at = 'body/label'): Issue[] {
  const trimmed = label.trim()
  if (trimmed === '') return [{ path: at, message: 'Give the version a label, for example 2026-10.' }]
  if (trimmed.length > LABEL_MAX) return [{ path: at, message: `At most ${LABEL_MAX} characters.` }]
  return []
}

/** Problems of one language's text (the body sent). */
export function textProblems(input: { readonly locale: string; readonly body: string }, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!isLocale(input.locale)) problems.push({ path: 'params/locale', message: 'A language is its two-letter ISO 639-1 code, for example it, en or ro.' })
  const body = normaliseNoticeBody(input.body)
  if (body.trim() === '') problems.push({ path: `${at}/body`, message: 'The text is empty.' })
  else if (body.length > BODY_MAX) problems.push({ path: `${at}/body`, message: `At most ${BODY_MAX} characters.` })
  return problems
}

/** One language of a version, as publishing checks it. */
export interface NoticeLanguage {
  readonly locale: string
  readonly hasBody: boolean
  readonly hasPdf: boolean
}

/** What stops a DRAFT from being published, in words (empty: it may be). */
export function publishProblems(input: { readonly kind: NoticeKind; readonly status: NoticeStatus; readonly languages: readonly NoticeLanguage[] }): Issue[] {
  if (input.status !== 'DRAFT') return [{ path: 'state', message: `This version is ${input.status.toLowerCase()}: only a draft is published.` }]
  const problems: Issue[] = []
  for (const locale of requiredLanguages(input.kind)) {
    if (!input.languages.some((language) => language.locale === locale && language.hasBody)) {
      problems.push({ path: `texts/${locale}`, message: `Write the ${locale === 'it' ? 'Italian' : 'English'} text first: ${NOTICE_KIND_WORDS[input.kind]} is shown in it on screen.` })
    }
  }
  return problems
}

/** The language a person reads: theirs when the version has it as text, else Italian, else English, else the first. */
export function pickLanguage(available: readonly string[], wanted: string | null | undefined): string | null {
  for (const locale of [wanted, 'it', 'en']) if (locale && available.includes(locale)) return locale
  return available[0] ?? null
}

/**
 * A person's state against the version in force: none in force, acknowledged it, or still to acknowledge it. An
 * acknowledgement of another version (or of none) never counts once a version is in force.
 */
export type NoticeAckState = 'NONE_IN_FORCE' | 'ACKNOWLEDGED' | 'DUE'

export function noticeAckState(input: { readonly inForceId: string | null; readonly acknowledgedIds: readonly (string | null)[] }): NoticeAckState {
  if (input.inForceId === null) return 'NONE_IN_FORCE'
  return input.acknowledgedIds.includes(input.inForceId) ? 'ACKNOWLEDGED' : 'DUE'
}

/** The words an acknowledgement means, shown beside the button (design floor.notice). */
export const ACKNOWLEDGE_MEANS = 'This records that you saw this notice. It does not sign anything else.'
