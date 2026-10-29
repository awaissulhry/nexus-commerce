import type { Issue } from '../core/errors'

/**
 * The DPIA and the record of processing activities (B-W1-36; A2 SCR-086; GDPR arts. 28, 30 and 35; GAP-004, GAP-009,
 * MES-282): their rules, pure (factory-db's …_privacy_guards triggers hold the same for every login).
 *
 * DPIA: written as a DRAFT with its scope, its signed PDF uploaded on it, then STORED (who signed it for the
 * controller, on which day, and when it is reviewed next: art. 35(11)); a later version supersedes it. The floor's gate
 * reads the stored one (readiness.ts).
 *
 * Record of processing activities (art. 30(1)): one row per activity: what, why, on which lawful basis, about whom,
 * which data, to whom (and which processors under art. 28, with their region), transfers outside the EEA, how long, and
 * how it is protected. Archived when the processing stops, never deleted.
 */

export const DPIA_STATUSES = ['DRAFT', 'STORED', 'SUPERSEDED'] as const
export type DpiaStatus = (typeof DPIA_STATUSES)[number]

export const PROCESSING_ACTIVITY_STATUSES = ['ACTIVE', 'ARCHIVED'] as const

export const SCOPE_MAX = 2_000
export const NAME_MAX = 200
export const TEXT_MAX = 2_000
export const LIST_MAX = 30
const CODE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/

/** The scope a DPIA starts from: what the factory's own processing of people at work is (made-up wording, editable). */
export const DEFAULT_DPIA_SCOPE =
  'Floor tools: badge sign-ins on the tablets and the scans and cut logs that name the signed-in worker. Office staff data: the audit trail of who changed what, and staff mail kept on record threads.'

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''

/** Problems of a DPIA's scope. */
export function dpiaScopeProblems(scope: string, at = 'body/scope'): Issue[] {
  if (blank(scope)) return [{ path: at, message: 'Say what the DPIA assesses.' }]
  return scope.trim().length > SCOPE_MAX ? [{ path: at, message: `At most ${SCOPE_MAX} characters.` }] : []
}

/** What storing a DPIA as signed needs, in words (empty: it may be stored). Dates are YYYY-MM-DD. */
export function dpiaStoreProblems(input: {
  readonly status: DpiaStatus
  readonly hasPdf: boolean
  readonly signedByName: string
  readonly signedOn: string
  readonly reviewDueOn: string
  readonly today: string
}): Issue[] {
  if (input.status !== 'DRAFT') return [{ path: 'state', message: `This DPIA is ${input.status.toLowerCase()}: only a draft is stored.` }]
  const problems: Issue[] = []
  if (!input.hasPdf) problems.push({ path: 'state', message: 'Upload the signed PDF first.' })
  if (blank(input.signedByName)) problems.push({ path: 'body/signedByName', message: 'Who signed it for the company, as the document says.' })
  else if (input.signedByName.trim().length > NAME_MAX) problems.push({ path: 'body/signedByName', message: `At most ${NAME_MAX} characters.` })
  if (input.signedOn > input.today) problems.push({ path: 'body/signedOn', message: 'The day it was signed is today or earlier.' })
  if (input.reviewDueOn <= input.signedOn) problems.push({ path: 'body/reviewDueOn', message: 'The review day comes after the day it was signed.' })
  return problems
}

/** A processing activity as the office writes it. */
export interface ProcessingActivityInput {
  readonly code: string
  readonly name: string
  readonly purpose: string
  readonly legalBasis: string
  readonly dataSubjects: readonly string[]
  readonly dataCategories: readonly string[]
  readonly recipients: readonly string[]
  readonly processors: readonly string[]
  readonly transfers: string
  readonly retention: string
  readonly security: string
}

const TEXTS = ['name', 'purpose', 'legalBasis', 'transfers', 'retention', 'security'] as const
const LISTS = ['dataSubjects', 'dataCategories', 'recipients', 'processors'] as const

/** Problems of a processing activity (art. 30(1)); `partial`: only the fields given (a PATCH). */
export function activityProblems(input: Partial<ProcessingActivityInput>, partial = false, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!partial || input.code !== undefined) {
    if (input.code === undefined || !CODE.test(input.code)) problems.push({ path: `${at}/code`, message: 'A short code in capitals, digits, dots, dashes or underscores (at most 40), for example FLOOR-SCANS.' })
  }
  for (const field of TEXTS) {
    const value = input[field]
    if (partial && value === undefined) continue
    if (blank(value)) problems.push({ path: `${at}/${field}`, message: 'Required.' })
    else if (value!.trim().length > (field === 'name' ? NAME_MAX : TEXT_MAX)) problems.push({ path: `${at}/${field}`, message: `At most ${field === 'name' ? NAME_MAX : TEXT_MAX} characters.` })
  }
  for (const field of LISTS) {
    const value = input[field]
    if (partial && value === undefined) continue
    const entries = (value ?? []).map((entry) => entry.trim())
    if ((field === 'dataSubjects' || field === 'dataCategories') && entries.length === 0) problems.push({ path: `${at}/${field}`, message: 'Name at least one.' })
    if (entries.length > LIST_MAX) problems.push({ path: `${at}/${field}`, message: `At most ${LIST_MAX}.` })
    if (entries.some((entry) => entry === '' || entry.length > NAME_MAX)) problems.push({ path: `${at}/${field}`, message: `Each one is a word or a phrase of at most ${NAME_MAX} characters.` })
  }
  return problems
}

/** The list as stored: trimmed, without blanks or repeats, in the order given. */
export const cleanList = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))]
