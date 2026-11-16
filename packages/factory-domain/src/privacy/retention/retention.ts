import type { Issue } from '../../core/errors'
import { businessDate, type BusinessDate } from '../../core/time'

/**
 * Retention rules per record type and their sweeps (B-W2b-405; PLT-204; GDPR art. 5(1)(e); c.c. art. 2220; design admin.privacy
 * "Retention rules": record type, keep for, then, legal reason, last sweep; "Shortening needs the Owner (fresh code)"). The lists
 * are the factory-db enums, value for value (the API's PG test holds it).
 *
 * GATE-PRIVACY: the periods wait for the Owner's privacy consultant. A rule is made with a made-up period (UNVERIFIED) and only
 * REPORTS what it would do until a person switches it on (RetentionRule.applyOn, with a fresh code); the database refuses an
 * APPLY sweep of a rule nobody switched on. The append-only ledgers are never swept and never purged (the Owner's decision of
 * 15 November 2026).
 */

export const RETENTION_ACTIONS = ['DELETE', 'ANONYMISE', 'ARCHIVE'] as const
export type RetentionAction = (typeof RETENTION_ACTIONS)[number]

export const SWEEP_MODES = ['REPORT', 'APPLY'] as const
export type SweepMode = (typeof SWEEP_MODES)[number]

export const SWEEP_STATUSES = ['RUNNING', 'DONE', 'FAILED'] as const
export type SweepStatus = (typeof SWEEP_STATUSES)[number]

export const ERASURE_METHODS = ['ANONYMISED', 'DELETED', 'KEPT'] as const
export type ErasureMethod = (typeof ERASURE_METHODS)[number]

export const RULE_LIMITS = Object.freeze({ minMonths: 1, maxMonths: 1200, legalReason: 1000, perSweep: 5000 })

/** The rule's unique key: `retention:<Model>:<company id | all>` (the database checks it). */
export const ruleKey = (recordType: string, companyId: string | null): string => `retention:${recordType}:${companyId ?? 'all'}`

/** A sweep's mode: APPLY only while the rule is switched on (GATE-PRIVACY), else REPORT. */
export const sweepModeOf = (rule: { readonly applyOn: boolean }): SweepMode => (rule.applyOn ? 'APPLY' : 'REPORT')

/**
 * The sweep's cut-off: the business day (Europe/Rome) of the start less the months, a month end clamped (31 March less one
 * month is 28 or 29 February), exactly as the database's check. Records counted from before this day are due.
 */
export function cutoffOf(startedAt: Date, months: number): BusinessDate {
  const [year, month, day] = businessDate(startedAt).split('-').map(Number) as [number, number, number]
  const total = year * 12 + (month - 1) - months
  const y = Math.floor(total / 12)
  const m = total - y * 12
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const pad = (value: number, length: number) => String(value).padStart(length, '0')
  return `${pad(y, 4)}-${pad(m + 1, 2)}-${pad(Math.min(day, last), 2)}`
}

/** "12 months", "10 years", "2 years and 6 months": the period in words (English; the web words it in its language). */
export function periodWords(months: number): string {
  const years = Math.floor(months / 12)
  const rest = months % 12
  const y = years === 0 ? '' : `${years} ${years === 1 ? 'year' : 'years'}`
  const m = rest === 0 ? '' : `${rest} ${rest === 1 ? 'month' : 'months'}`
  return y && m ? `${y} and ${m}` : y || m
}

export interface RuleInput {
  readonly keepMonths: number
  readonly thenAction: string
  readonly legalReason: string
}

/** A rule's own mistakes, in words: 1-1200 whole months, an action the record type takes, a legal reason of 3-1000 characters. */
export function ruleProblems(input: RuleInput, actions: readonly RetentionAction[]): Issue[] {
  const problems: Issue[] = []
  if (!Number.isInteger(input.keepMonths) || input.keepMonths < RULE_LIMITS.minMonths || input.keepMonths > RULE_LIMITS.maxMonths) {
    problems.push({ path: 'keepMonths', message: `Keep it for whole months, from ${RULE_LIMITS.minMonths} to ${RULE_LIMITS.maxMonths} (100 years).` })
  }
  if (!actions.includes(input.thenAction as RetentionAction)) {
    problems.push({ path: 'thenAction', message: actions.length === 0 ? 'This record type is kept: no sweep may delete, anonymise or archive it.' : `This record type can only be: ${actions.map((action) => ACTION_WORDS[action]).join(', ')}.` })
  }
  const reason = input.legalReason.trim()
  if (reason.length < 3) problems.push({ path: 'legalReason', message: 'Say the legal reason for the period (3 characters or more), e.g. c.c. art. 2220: 10 years.' })
  else if (reason.length > RULE_LIMITS.legalReason) problems.push({ path: 'legalReason', message: `The legal reason is at most ${RULE_LIMITS.legalReason} characters.` })
  return problems
}

/** Shortening a period (or switching a rule on) asks the Owner's fresh code (the design's "Shortening needs the Owner"). */
export const isShortening = (before: number, after: number): boolean => after < before

export const ACTION_WORDS: Readonly<Record<RetentionAction, string>> = Object.freeze({
  DELETE: 'delete',
  ANONYMISE: 'anonymise',
  ARCHIVE: 'archive',
})

/**
 * Why a sweep left a due record as it was: a code each, with its words. HELD records count in `heldCount`; nothing about them
 * changed.
 */
export const SWEEP_HELD = ['NEVER_DELETED', 'ARCHIVE_STAYS', 'NOT_YET'] as const
export type SweepHeld = (typeof SWEEP_HELD)[number]

export const SWEEP_HELD_WORDS: Readonly<Record<SweepHeld, string>> = Object.freeze({
  NEVER_DELETED: 'The database never deletes this record (an export expires, its file goes): the rule can only report it.',
  ARCHIVE_STAYS: 'Archived where it is: nothing is erased (the fiscal archive keeps the document and its file for the law).',
  NOT_YET: 'Not yet: the database keeps it a little longer (a closed error item 30 days, a job run 7 days).',
})

/**
 * The ledgers the database keeps append-only: never swept and never purged after a period (the Owner's decision of 15 November
 * 2026, answering B-W2b-405's question). An erasure request still blanks the person's details inside an audit row (B-W2b-F54);
 * the row stays.
 */
export const APPEND_ONLY_LEDGERS = ['AuditLog', 'ReadLog', 'SecurityEvent', 'StepUpAttempt'] as const
export type AppendOnlyLedger = (typeof APPEND_ONLY_LEDGERS)[number]

export const LEDGER_WORDS: Readonly<Record<AppendOnlyLedger, string>> = Object.freeze({
  AuditLog: 'Every change to a record, who made it and when (append-only).',
  ReadLog: 'Who opened or downloaded a sensitive record (append-only).',
  SecurityEvent: 'Sign-ins, failed sign-ins, lockouts, role changes and exports (append-only).',
  StepUpAttempt: 'Every try of a fresh code (append-only).',
})

export const LEDGER_KEPT_WORDS = "Kept for good: the database keeps it append-only and it is never purged after a period (the Owner's decision of 15 November 2026)."

/** Records the privacy pack keeps for good: the requests and their answers, the rules and their sweeps, what an erasure did. */
export const KEPT_FOR_GOOD = ['DataRequest', 'ErasureRecord', 'RetentionRule', 'RetentionSweep'] as const

/**
 * The purges that already run on their own dates (the one-off purges of W2b-3 and W2b-5, each by its own scheduled job):
 * listed beside the rules so the screen shows every way personal data leaves, not editable here (their periods are the
 * Owner's answers or a security rule; their jobs keep running).
 */
export const DATED_PURGES = Object.freeze([
  { key: 'measurementPhotos', job: 'sales.measurementPhotos', recordType: 'StoredFile', what: 'Body photos sent with measurements by link, the made-to-measure office photos and the fitting photos', when: '90 days after the garment ships (each photo on its own delete date), hourly; the measurements stay in the profile', why: "Owner answer 3 of W2b-3 (GDPR art. 5(1)(c), (e))" },
  { key: 'portalCodes', job: 'portal.purgeCodes', recordType: 'PortalSignInCode', what: 'Portal sign-in and step-up codes', when: 'a day after they expired, hourly', why: 'GDPR art. 5(1)(e); kept a day for the security log of a recent sign-in' },
  { key: 'linkDrafts', job: 'links.purgeDrafts', recordType: 'LinkDraft', what: 'Drafts of link forms (measurements, claims, questionnaires)', when: '7 days after their link expired, hourly', why: 'GDPR art. 5(1)(e)' },
  { key: 'largeUploads', job: 'files.expireLargeUploads', recordType: 'FileUploadSession', what: 'Uploads in parts never finished', when: 'when their upload window ends, hourly', why: 'GDPR art. 5(1)(e)' },
  { key: 'exportFiles', job: 'exports.expire', recordType: 'ExportJob', what: 'The files of exports', when: 'when the export expires, hourly (the export row stays)', why: 'GDPR art. 5(1)(e)' },
  // B-W2b-GF1 (G274): the access request's package (requests.ts PACKAGE_KEEP_DAYS).
  { key: 'accessPackages', job: 'privacy.purgePackages', recordType: 'StoredFile', what: "A person's data package (the copy an access request collected)", when: '30 days after it was made, hourly (the request and its record of what was sent stay)', why: 'GDPR art. 5(1)(e): never kept as a second copy of the person\'s data' },
] as const)

/** Why a sweep failed: a code each (RetentionSweep.failures), with its words. */
export const SWEEP_FAILURES = ['UNKNOWN_TYPE', 'DB_REFUSED', 'STOPPED'] as const
export type SweepFailure = (typeof SWEEP_FAILURES)[number]

export const SWEEP_FAILURE_WORDS: Readonly<Record<SweepFailure, string>> = Object.freeze({
  UNKNOWN_TYPE: 'The sweep knows nothing of this record type: it can only report the rule. Ask for the type to be added.',
  DB_REFUSED: 'The database refused the change: nothing of this sweep was applied. It is tried again at the next sweep.',
  STOPPED: 'The sweep stopped before it ended: nothing of it was applied. It is tried again at the next sweep.',
})

/** Why a rule action cannot be taken now: a code each, with its words. */
export const RULE_HELD = ['SWITCHED_OFF', 'ACTIVE', 'APPLYING', 'NOT_APPLYING', 'UNKNOWN_TYPE', 'NO_ACTION'] as const
export type RuleHeld = (typeof RULE_HELD)[number]

export const RULE_HELD_WORDS: Readonly<Record<RuleHeld, string>> = Object.freeze({
  SWITCHED_OFF: 'The rule is switched off: switch it on again first.',
  ACTIVE: 'The rule is on already.',
  APPLYING: 'The sweep already applies this rule.',
  NOT_APPLYING: 'The sweep only reports this rule (it is not switched on to apply).',
  UNKNOWN_TYPE: 'The sweep knows nothing of this record type: the rule can only report.',
  NO_ACTION: 'No sweep may delete, anonymise or archive this record type: the rule can only report.',
})

/** Every period here is made up until the privacy paperwork is signed (GATE-PRIVACY): the screen says UNVERIFIED. */
export const PERIODS_UNVERIFIED = true
export const UNVERIFIED_WORDS = "UNVERIFIED: a made-up period until the Owner's privacy consultant sets it (GATE-PRIVACY). The sweep only reports until a person switches the rule on."
