import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { DECLARATION_KINDS, SUBSTANCE_UNITS, type DeclarationKind, type SubstanceUnit } from '../substances/rules'

/**
 * Declarations asked of suppliers (B-W2b-256; PRD-304, REACH art. 33; design compliance.tests › Supplier declarations, the
 * Request declarations pop-up and the Supplier declaration record), the pure part: what a request may ask, how the
 * materials asked become one request per supplier and kind (a material added to an open request of that supplier and kind
 * instead of a second one), how an answer is written per material, when a reminder is due, and the status the office's list
 * shows. B-W2b-217's …_substances_w2b_guards hold the same rules for every login (they speak last). No money anywhere.
 */

export const DECLARATION_CHANNELS = ['PORTAL', 'LINK', 'OFFICE'] as const
export type DeclarationChannel = (typeof DECLARATION_CHANNELS)[number]
/** How a request may go out today: a task in the supplier's portal, or asked by the office (e-mail by hand). No link purpose exists for a declaration yet. */
export const ASK_CHANNELS = ['PORTAL', 'OFFICE'] as const
export type AskChannel = (typeof ASK_CHANNELS)[number]
export const DECLARATION_STATUSES = ['SENT', 'ANSWERED', 'ACCEPTED', 'REFUSED', 'OVERDUE', 'CANCELLED'] as const
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number]
/** Waiting for the supplier's answer. */
export const WAITING: ReadonlySet<DeclarationStatus> = new Set(['SENT', 'OVERDUE'])
/** Open: waiting, or answered and not decided yet (lines may still be written). */
export const OPEN: ReadonlySet<DeclarationStatus> = new Set(['SENT', 'OVERDUE', 'ANSWERED'])

/** The status the list shows (design ts-decl: Requested / Answered / Accepted / Rejected / Expired / Re-request needed), with Overdue and Cancelled. */
export const SHOWN_STATUSES = ['REQUESTED', 'OVERDUE', 'ANSWERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'REREQUEST_NEEDED', 'CANCELLED'] as const
export type ShownStatus = (typeof SHOWN_STATUSES)[number]

export const DECLARATION_LIMITS = {
  message: 2000,
  internalNote: 2000,
  reason: 500,
  articleLabel: 200,
  substanceName: 300,
  note: 1000,
  /** The latest due day a request may name, in days from today. */
  dueDays: 180,
  reminderMin: 1,
  reminderMax: 90,
  /** Materials in one Request declarations. */
  materials: 100,
  /** Lines one request holds. */
  lines: 200,
  /** The partner task's label (PartnerTask.recordLabel). */
  taskLabel: 200,
} as const

/** What each kind asks, in words the supplier and the office read. */
export const KIND_WORDS: Readonly<Record<DeclarationKind, string>> = Object.freeze({
  REACH_SVHC: 'REACH SVHC declaration: substances of very high concern of the Candidate List above 0.1 % w/w (art. 33)',
  RSL: 'restricted substance list declaration',
  PFAS: 'PFAS-free declaration (no intentionally added PFAS)',
  NICKEL: 'nickel release declaration (REACH Annex XVII entry 27)',
  CR6: 'chromium VI statement (REACH Annex XVII entry 47)',
  OTHER: 'declaration',
})
/** The short words of a kind (a list column, a task label). */
export const KIND_SHORT: Readonly<Record<DeclarationKind, string>> = Object.freeze({ REACH_SVHC: 'SVHC', RSL: 'RSL', PFAS: 'PFAS-free', NICKEL: 'Nickel release', CR6: 'Cr VI', OTHER: 'Declaration' })

/** The source key of a request's partner task (platform/portal/tasks/sources: prefix `SupplierDeclaration`). */
export const TASK_PREFIX = 'SupplierDeclaration'
export const taskSourceKey = (requestId: string): string => `${TASK_PREFIX}:${requestId}`
/** The request of a task's source key (null: not one of ours). */
export const requestOfSourceKey = (sourceKey: string): string | null => (sourceKey.startsWith(`${TASK_PREFIX}:`) ? sourceKey.slice(TASK_PREFIX.length + 1) || null : null)

const CONTROL = /\p{Cc}/u
const CONTROL_BUT_LINES = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const wordsOk = (words: string | null | undefined, longest: number, lines = false): boolean =>
  words === null || words === undefined || (words.trim() !== '' && words.length <= longest && !(lines ? CONTROL_BUT_LINES : CONTROL).test(words))

/** A business day `days` later (or earlier). */
export function addDays(day: BusinessDate, days: number): BusinessDate {
  const at = new Date(`${day}T12:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface AskDraft {
  readonly kinds: readonly string[]
  readonly dueOn: string
  readonly reminderEveryDays?: number | null | undefined
  readonly message?: string | null | undefined
  readonly channel?: string | null | undefined
}

/** What is wrong with a Request declarations (every problem at once; `body/…` paths). */
export function askProblems(draft: AskDraft, today: BusinessDate, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (draft.kinds.length === 0) problems.push({ path: `${at}/kinds`, message: 'Ask for at least one kind of declaration.' })
  draft.kinds.forEach((kind, index) => {
    if (!(DECLARATION_KINDS as readonly string[]).includes(kind)) problems.push({ path: `${at}/kinds/${index}`, message: `One of ${DECLARATION_KINDS.join(', ')}.` })
    else if (draft.kinds.indexOf(kind) !== index) problems.push({ path: `${at}/kinds/${index}`, message: `${kind} is asked once.` })
  })
  if (!DAY.test(draft.dueOn)) problems.push({ path: `${at}/dueOn`, message: 'A day (YYYY-MM-DD).' })
  else if (draft.dueOn < today) problems.push({ path: `${at}/dueOn`, message: 'The due day is today or later.' })
  else if (draft.dueOn > addDays(today, DECLARATION_LIMITS.dueDays)) problems.push({ path: `${at}/dueOn`, message: `At most ${DECLARATION_LIMITS.dueDays} days from today.` })
  const every = draft.reminderEveryDays
  if (every !== null && every !== undefined && (!Number.isInteger(every) || every < DECLARATION_LIMITS.reminderMin || every > DECLARATION_LIMITS.reminderMax)) {
    problems.push({ path: `${at}/reminderEveryDays`, message: `Remind every ${DECLARATION_LIMITS.reminderMin} to ${DECLARATION_LIMITS.reminderMax} days, or never.` })
  }
  if (!wordsOk(draft.message, DECLARATION_LIMITS.message, true)) problems.push({ path: `${at}/message`, message: `Up to ${DECLARATION_LIMITS.message} characters.` })
  if (draft.channel === 'LINK') problems.push({ path: `${at}/channel`, message: 'Asking by link is not offered yet: ask in the supplier portal (PORTAL) or by e-mail (OFFICE).' })
  else if (draft.channel !== null && draft.channel !== undefined && !(ASK_CHANNELS as readonly string[]).includes(draft.channel)) problems.push({ path: `${at}/channel`, message: 'PORTAL or OFFICE.' })
  return problems
}

// ---- one request per supplier and kind -------------------------------------------------------------------------------

export interface AskMaterial {
  readonly itemId: string
  readonly code: string
  readonly name: string
  /** The suppliers asked about it: the one named, or its default supplier and its active sources. */
  readonly suppliers: readonly { readonly partyId: string; readonly articleCode: string | null }[]
}

export interface AskParty {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly portalOn: boolean
  /** Why it cannot be asked (not a supplier, blocked, of another company): null when it can. */
  readonly refusal: string | null
}

/** An open request of a supplier (SENT, OVERDUE or ANSWERED) with the materials it asks about. */
export interface OpenRequest {
  readonly requestId: string
  readonly number: string
  readonly partyId: string
  readonly kind: DeclarationKind
  readonly status: DeclarationStatus
  readonly svhcListVersionId: string | null
  readonly itemIds: readonly string[]
  readonly lines: number
}

export type AskOutcome = 'SEND' | 'ADD' | 'SKIP'

export interface AskGroup {
  readonly partyId: string
  readonly kind: DeclarationKind
  readonly channel: AskChannel | null
  /** SEND: a new request; ADD: the materials not yet on an open request of this supplier and kind join it; SKIP: nothing (why). */
  readonly outcome: AskOutcome
  readonly why: string | null
  readonly lines: readonly { readonly itemId: string; readonly articleLabel: string }[]
  /** ADD: the open request; SKIP: the request that already asks it, if one does. */
  readonly openRequest: { readonly requestId: string; readonly number: string } | null
}

/** How the supplier knows the material: its article code (when it has one) and our name, up to 200 characters. */
export function articleLabelOf(material: { readonly code: string; readonly name: string }, articleCode: string | null): string {
  const label = `${articleCode?.trim() || material.code} · ${material.name}`
  return label.length <= DECLARATION_LIMITS.articleLabel ? label : `${label.slice(0, DECLARATION_LIMITS.articleLabel - 1)}…`
}

/**
 * The requests a Request declarations makes: one per supplier and kind (design ts-request "review per supplier"). A
 * supplier with an open request of that kind (for REACH_SVHC: against the same Candidate List version) is not asked twice:
 * while it waits (SENT, OVERDUE) the materials not on it yet are added to it; once answered it is decided first. The
 * channel is the one asked, else the portal when the supplier's portal is on, else the office (e-mail by hand); the portal
 * asked of a supplier whose portal is off is skipped with why.
 */
export function planAsk(input: {
  readonly materials: readonly AskMaterial[]
  readonly parties: ReadonlyMap<string, AskParty>
  readonly kinds: readonly DeclarationKind[]
  readonly open: readonly OpenRequest[]
  readonly channel: AskChannel | null
  /** The Candidate List version a REACH_SVHC request asks about (null: none recorded). */
  readonly svhcListVersionId: string | null
}): AskGroup[] {
  const byParty = new Map<string, { itemId: string; articleLabel: string }[]>()
  for (const material of input.materials) {
    for (const supplier of material.suppliers) {
      const list = byParty.get(supplier.partyId) ?? []
      if (!list.some((line) => line.itemId === material.itemId)) list.push({ itemId: material.itemId, articleLabel: articleLabelOf(material, supplier.articleCode) })
      byParty.set(supplier.partyId, list)
    }
  }
  const groups: AskGroup[] = []
  for (const [partyId, lines] of byParty) {
    const party = input.parties.get(partyId)
    for (const kind of input.kinds) {
      const base = { partyId, kind, lines }
      if (!party) {
        groups.push({ ...base, channel: null, outcome: 'SKIP', why: 'Not a party of this company.', openRequest: null })
        continue
      }
      if (party.refusal) {
        groups.push({ ...base, channel: null, outcome: 'SKIP', why: party.refusal, openRequest: null })
        continue
      }
      if (kind === 'REACH_SVHC' && input.svhcListVersionId === null) {
        groups.push({ ...base, channel: null, outcome: 'SKIP', why: 'No Candidate List version is recorded: record the ECHA list it asks about first.', openRequest: null })
        continue
      }
      const open = input.open.find((request) => request.partyId === partyId && request.kind === kind && (kind !== 'REACH_SVHC' || request.svhcListVersionId === input.svhcListVersionId))
      if (open) {
        const ref = { requestId: open.requestId, number: open.number }
        const fresh = lines.filter((line) => !open.itemIds.includes(line.itemId))
        if (open.status === 'ANSWERED') {
          groups.push({ ...base, channel: null, outcome: 'SKIP', why: `${party.code} answered ${open.number} already: decide it, then ask again.`, openRequest: ref })
        } else if (fresh.length === 0) {
          groups.push({ ...base, channel: null, outcome: 'SKIP', why: `Already asked in ${open.number} (due, not answered yet).`, openRequest: ref })
        } else if (open.lines + fresh.length > DECLARATION_LIMITS.lines) {
          groups.push({ ...base, lines: fresh, channel: null, outcome: 'SKIP', why: `${open.number} would hold more than ${DECLARATION_LIMITS.lines} lines.`, openRequest: ref })
        } else {
          groups.push({ ...base, lines: fresh, channel: null, outcome: 'ADD', why: `Added to ${open.number}, which waits for its answer.`, openRequest: ref })
        }
        continue
      }
      if (lines.length > DECLARATION_LIMITS.lines) {
        groups.push({ ...base, channel: null, outcome: 'SKIP', why: `At most ${DECLARATION_LIMITS.lines} materials in one request.`, openRequest: null })
        continue
      }
      const channel: AskChannel = input.channel ?? (party.portalOn ? 'PORTAL' : 'OFFICE')
      if (channel === 'PORTAL' && !party.portalOn) {
        groups.push({ ...base, channel, outcome: 'SKIP', why: `${party.code}'s portal is off: ask by e-mail (OFFICE), or switch its portal on first.`, openRequest: null })
        continue
      }
      groups.push({ ...base, channel, outcome: 'SEND', why: null, openRequest: null })
    }
  }
  return groups.sort((a, b) => a.partyId.localeCompare(b.partyId) || DECLARATION_KINDS.indexOf(a.kind) - DECLARATION_KINDS.indexOf(b.kind))
}

/** The partner task's label: the number, the kind and the materials as the supplier knows them (200 characters at most). */
export function taskLabelOf(number: string, kind: DeclarationKind, articleLabels: readonly string[]): string {
  const label = `${number} · ${KIND_SHORT[kind]} · ${articleLabels.join('; ')}`
  return label.length <= DECLARATION_LIMITS.taskLabel ? label : `${label.slice(0, DECLARATION_LIMITS.taskLabel - 1)}…`
}

// ---- the answer per material -----------------------------------------------------------------------------------------

export interface LineAnswer {
  readonly contains: boolean | null
  readonly aboveThreshold?: boolean | null | undefined
  readonly substanceId?: string | null | undefined
  readonly substanceName?: string | null | undefined
  readonly concentration?: string | null | undefined
  readonly concentrationUnit?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface CleanAnswer {
  readonly contains: boolean | null
  readonly aboveThreshold: boolean | null
  readonly substanceId: string | null
  readonly substanceName: string | null
  readonly concentration: string | null
  readonly concentrationUnit: SubstanceUnit | null
  readonly note: string | null
}

const NUMBER = /^\d{1,12}(\.\d{1,6})?$/
const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())

/**
 * One line's answer, checked and cleaned (`at`: its path). Not answered (null) or no: nothing more. Yes: whether above the
 * threshold, which substance (of our list and/or as the supplier named it) and its concentration with its unit. An SVHC
 * declaration in % w/w is above the threshold exactly when over 0.1 % (REACH art. 33): said for the person when left out.
 */
export function lineAnswer(answer: LineAnswer, kind: DeclarationKind, at: string): { readonly answer: CleanAnswer; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const name = blank(answer.substanceName)
  const concentration = blank(answer.concentration)
  const unit = blank(answer.concentrationUnit)
  const note = blank(answer.note)
  if (!wordsOk(note, DECLARATION_LIMITS.note, true)) problems.push({ path: `${at}/note`, message: `Up to ${DECLARATION_LIMITS.note} characters.` })
  if (answer.contains !== true) {
    if (answer.aboveThreshold !== null && answer.aboveThreshold !== undefined) problems.push({ path: `${at}/aboveThreshold`, message: 'Only when it contains what was asked.' })
    if (answer.substanceId || name || concentration || unit) problems.push({ path: `${at}/substanceId`, message: 'A substance and its concentration only when it contains what was asked.' })
    return { answer: { contains: answer.contains, aboveThreshold: null, substanceId: null, substanceName: null, concentration: null, concentrationUnit: null, note }, problems }
  }
  if (!answer.substanceId && !name) problems.push({ path: `${at}/substanceName`, message: 'Name the substance (of the list, or as the supplier wrote it).' })
  if (name !== null && !wordsOk(name, DECLARATION_LIMITS.substanceName)) problems.push({ path: `${at}/substanceName`, message: `Up to ${DECLARATION_LIMITS.substanceName} characters.` })
  if ((concentration === null) !== (unit === null)) problems.push({ path: `${at}/concentration`, message: 'A concentration with its unit, or neither.' })
  if (concentration !== null && !NUMBER.test(concentration)) problems.push({ path: `${at}/concentration`, message: 'A number from 0, up to 6 decimals.' })
  if (unit !== null && !(SUBSTANCE_UNITS as readonly string[]).includes(unit)) problems.push({ path: `${at}/concentrationUnit`, message: `One of ${SUBSTANCE_UNITS.join(', ')}.` })
  let above = answer.aboveThreshold ?? null
  if (kind === 'REACH_SVHC' && unit === 'PERCENT_WW' && concentration !== null && NUMBER.test(concentration)) {
    const over = Number(concentration) > 0.1
    if (above === null) above = over
    else if (above !== over) problems.push({ path: `${at}/aboveThreshold`, message: `${concentration} % w/w is ${over ? 'over' : 'not over'} the 0.1 % threshold of REACH art. 33.` })
  }
  if (above === null) problems.push({ path: `${at}/aboveThreshold`, message: 'Say whether it is above the threshold (0.1 % w/w for an SVHC, the rule\'s limit otherwise).' })
  return {
    answer: { contains: true, aboveThreshold: above, substanceId: answer.substanceId ?? null, substanceName: name, concentration, concentrationUnit: unit as SubstanceUnit | null, note },
    problems,
  }
}

// ---- decisions and reminders -----------------------------------------------------------------------------------------

/** Why a refusal (3 to 500 characters, read by the supplier) is not valid, or null. */
export function refuseProblem(reason: string | null | undefined): string | null {
  const words = (reason ?? '').trim()
  return words.length < 3 || !wordsOk(words, DECLARATION_LIMITS.reason, true) ? `Say why, in 3 to ${DECLARATION_LIMITS.reason} characters: the supplier reads it.` : null
}

/** Why a cancellation reason (1 to 500 characters) is not valid, or null. */
export function cancelProblem(reason: string | null | undefined): string | null {
  const words = (reason ?? '').trim()
  return words.length < 1 || !wordsOk(words, DECLARATION_LIMITS.reason, true) ? `Say why, in 1 to ${DECLARATION_LIMITS.reason} characters.` : null
}

const DAY_MS = 86_400_000

/** Is the request's own reminder due (every `reminderEveryDays` from the last reminder, or from when it went out)? */
export function reminderDue(request: { readonly status: string; readonly reminderEveryDays: number | null; readonly sentAt: Date; readonly lastRemindedAt: Date | null }, now: Date): boolean {
  if (!WAITING.has(request.status as DeclarationStatus) || request.reminderEveryDays === null) return false
  const from = request.lastRemindedAt ?? request.sentAt
  return now.getTime() - from.getTime() >= request.reminderEveryDays * DAY_MS
}

/**
 * The status the office's list shows. An accepted declaration whose validity ended is EXPIRED; an accepted SVHC declaration
 * judged against an older Candidate List than the newest is REREQUEST_NEEDED (the list grew: ask again).
 */
export function shownStatus(
  request: { readonly status: string; readonly kind: string; readonly validTo: BusinessDate | null; readonly svhcListVersionId: string | null; readonly answeredListVersionId: string | null },
  newestListVersionId: string | null,
  today: BusinessDate,
): ShownStatus {
  switch (request.status) {
    case 'SENT':
      return 'REQUESTED'
    case 'OVERDUE':
      return 'OVERDUE'
    case 'ANSWERED':
      return 'ANSWERED'
    case 'REFUSED':
      return 'REJECTED'
    case 'CANCELLED':
      return 'CANCELLED'
    default:
      if (request.validTo !== null && request.validTo < today) return 'EXPIRED'
      if (request.kind === 'REACH_SVHC' && newestListVersionId !== null && (request.answeredListVersionId ?? request.svhcListVersionId) !== newestListVersionId) return 'REREQUEST_NEEDED'
      return 'ACCEPTED'
  }
}

/** Days past the due day (0: not overdue). */
export const overdueDays = (dueOn: BusinessDate, today: BusinessDate): number => Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${dueOn}T12:00:00Z`)) / DAY_MS))
