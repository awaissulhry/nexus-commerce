import type { Issue } from '../../core/errors'
import { LANGUAGE_CODE, REASON_COLOURS, REASON_ICONS, REASON_LIMITS } from '../../reasons/rules'
import { REASON_CODE } from '../scans/reasons'

/**
 * Off-standard and indirect time (B-W2b-29; MES-155 … MES-158; design production.settings "Off-standard codes",
 * floor.operation "No bundle: what are you doing?", production.labour "Off-standard blocks to approve"), pure. The API
 * (modules/production/offstandard) says these in words before the …_floor_work_w2b_guards triggers would refuse the same.
 *
 *   codes    per company (pay is the employer's): a code (upper-case letters, digits, underscores) that never changes, a kind
 *            that never changes either (OFF_STANDARD: time lost to the work — waiting, a machine down, a help call;
 *            INDIRECT: useful work no standard covers — cleaning, training, samples, a meeting), a pay rule (AVERAGE earnings,
 *            BASE hourly, UNPAID; MES-155 — the CCNL's rules are UNVERIFIED: the company sets them with its labour
 *            consultant, and pay reads them behind its own switch), whether the team leader approves a block (MES-157), the
 *            words in Italian, English and the other floor languages, the design system's icon and colour, the tile order.
 *            A code no longer used is set inactive, never deleted.
 *   blocks   time recorded when no bundle runs (MES-156): OPEN while it runs, then PENDING (waiting for the team leader) or
 *            APPROVED at once (a code that needs no approval); PENDING → APPROVED | REJECTED (with why); a decided block is
 *            reopened (→ PENDING) with a reason. Never decided by the person it is about. Its day is the site's day it
 *            started in. After it ended, a change of its facts keeps before and after, who and why (MES-204).
 *   normal   a PENDING block the team leader may approve with others at once ("Approve 8 normal off-standard blocks"):
 *            not longer than an hour, recorded by the worker on the floor as it happened, never changed since. Anything
 *            else is decided one by one and says why (`unusualOf`).
 *
 * No figure here is about one person (Statuto dei Lavoratori art. 4; Owner answers W1, F2): a block's minutes are the
 * block's, and no list or total by person is ever made from them here.
 */

export const OFF_STANDARD_KINDS = ['OFF_STANDARD', 'INDIRECT'] as const
export type OffStandardKind = (typeof OFF_STANDARD_KINDS)[number]

export const PAY_RULES = ['AVERAGE', 'BASE', 'UNPAID'] as const
export type PayRule = (typeof PAY_RULES)[number]

export const BLOCK_STATUSES = ['OPEN', 'PENDING', 'APPROVED', 'REJECTED'] as const
export type BlockStatus = (typeof BLOCK_STATUSES)[number]

/** FLOOR the worker's tile, LEAD typed afterwards by the team leader or the office, HELP_CALL the waiting on a call, SYSTEM the API on its own. */
export const BLOCK_SOURCES = ['FLOOR', 'LEAD', 'HELP_CALL', 'SYSTEM'] as const
export type BlockSource = (typeof BLOCK_SOURCES)[number]

/**
 * What ended a block (its event): the worker's tap, a bundle scanned (standard work again), another tile (the next block
 * starts), the team leader or the office, the help call it waited on, the clock-out.
 */
export const BLOCK_ENDINGS = ['WORKER', 'SCAN', 'SWITCH', 'LEAD', 'HELP_CALL', 'CLOCK_OUT'] as const
export type BlockEnding = (typeof BLOCK_ENDINGS)[number]

/** Why a waiting block is not approved with others at once: decided one by one. */
export const UNUSUAL_REASONS = ['LONG', 'TYPED_AFTERWARDS', 'BY_SYSTEM', 'CHANGED'] as const
export type UnusualReason = (typeof UNUSUAL_REASONS)[number]

export const UNUSUAL_WORDS: Readonly<Record<UnusualReason, string>> = Object.freeze({
  LONG: 'longer than an hour',
  TYPED_AFTERWARDS: 'typed afterwards, not recorded on the floor as it happened',
  BY_SYSTEM: 'closed by the system, not by the worker',
  CHANGED: 'changed after it ended',
})

export const OFF_STANDARD_LIMITS = Object.freeze({
  label: REASON_LIMITS.label,
  languages: REASON_LIMITS.languages,
  /** A normal block (approved with others at once) lasts at most this many minutes. */
  normalMinutes: 60,
  /** No block lasts longer than a long shift. */
  longestMinutes: 16 * 60,
  note: 500,
  reason: 500,
  /** Blocks one bulk approval names at most. */
  perBulk: 200,
  /** A tablet clock ahead of the server by more than this is not believed. */
  deviceAheadMs: 2 * 60_000,
  /** A tablet time older than this is not believed: a block started offline longer ago is typed by the team leader. */
  deviceBehindMs: 12 * 60 * 60_000,
})

export const isOffStandardKind = (value: unknown): value is OffStandardKind => (OFF_STANDARD_KINDS as readonly unknown[]).includes(value)
export const isPayRule = (value: unknown): value is PayRule => (PAY_RULES as readonly unknown[]).includes(value)

// ---- codes -----------------------------------------------------------------------------------------------------------

/** What a new code or a change of one brings (only the fields present are checked). */
export interface CodeDraft {
  readonly code?: string | undefined
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  /** A change: a language with null is taken out. */
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly icon?: string | null | undefined
  readonly colour?: string | null | undefined
}

const blank = (value: string | undefined) => value !== undefined && value.trim() === ''

/** The problems of a code draft, each at its field (`code`, `labelIt`, `labelI18n/ro`, `icon` …). */
export function codeDraftProblems(draft: CodeDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.code !== undefined && !REASON_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits and underscores, starting with a letter (WAIT_MATERIAL).' })
  for (const field of ['labelIt', 'labelEn'] as const) {
    const value = draft[field]
    if (blank(value)) problems.push({ path: field, message: field === 'labelIt' ? 'Say the code in Italian.' : 'Say the code in English.' })
    else if (value !== undefined && value.trim().length > OFF_STANDARD_LIMITS.label) problems.push({ path: field, message: `At most ${OFF_STANDARD_LIMITS.label} characters.` })
  }
  if (draft.labelI18n !== undefined) {
    const entries = Object.entries(draft.labelI18n)
    if (entries.length > OFF_STANDARD_LIMITS.languages) problems.push({ path: 'labelI18n', message: `At most ${OFF_STANDARD_LIMITS.languages} other languages.` })
    for (const [language, words] of entries) {
      if (!LANGUAGE_CODE.test(language) || language === 'it' || language === 'en') problems.push({ path: `labelI18n/${language}`, message: 'A language is its ISO 639 code (ro, ur, zh); Italian and English have their own words.' })
      else if (words !== null && words.trim() === '') problems.push({ path: `labelI18n/${language}`, message: 'Leave a language out instead of blank words.' })
      else if (words !== null && words.trim().length > OFF_STANDARD_LIMITS.label) problems.push({ path: `labelI18n/${language}`, message: `At most ${OFF_STANDARD_LIMITS.label} characters.` })
    }
  }
  if (draft.icon !== undefined && draft.icon !== null && !(REASON_ICONS as readonly string[]).includes(draft.icon)) problems.push({ path: 'icon', message: 'Pick one of the icons offered.' })
  if (draft.colour !== undefined && draft.colour !== null && !(REASON_COLOURS as readonly string[]).includes(draft.colour.toLowerCase())) problems.push({ path: 'colour', message: 'Pick one of the colours offered.' })
  return problems
}

/** The words of a code in a language (it, en, else the other languages), else the English words. */
export function codeLabel(code: { readonly labelIt: string; readonly labelEn: string; readonly labelI18n?: Readonly<Record<string, string>> | null | undefined }, language: string): string {
  if (language === 'it') return code.labelIt
  if (language === 'en') return code.labelEn
  return code.labelI18n?.[language] ?? code.labelEn
}

/** The floor's tiles in their order: the tile order, then the code. */
export function tileOrder<Code extends { readonly sortOrder: number; readonly code: string }>(codes: readonly Code[]): Code[] {
  return [...codes].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
}

// ---- blocks ----------------------------------------------------------------------------------------------------------

/** A block's status when it ends: waiting for the team leader, or approved at once for a code that needs no approval. */
export const statusWhenEnded = (needsApproval: boolean): 'PENDING' | 'APPROVED' => (needsApproval ? 'PENDING' : 'APPROVED')

/** Whole minutes from the start to the end (a running block: to now), never below 0. */
export function minutesOf(startedAt: Date, endedAt: Date | null, now: Date = new Date()): number {
  const end = endedAt ?? now
  return Math.max(0, Math.floor((end.getTime() - startedAt.getTime()) / 60_000))
}

export interface BlockFacts {
  readonly status: BlockStatus
  readonly source: BlockSource
  readonly startedAt: Date
  readonly endedAt: Date | null
  /** A labour edit was written for it after it ended. */
  readonly edited: boolean
}

/** Why a block is not approved with others at once (empty: a normal block). */
export function unusualOf(block: BlockFacts, now: Date = new Date()): UnusualReason[] {
  const reasons: UnusualReason[] = []
  if (minutesOf(block.startedAt, block.endedAt, now) > OFF_STANDARD_LIMITS.normalMinutes) reasons.push('LONG')
  if (block.source === 'LEAD') reasons.push('TYPED_AFTERWARDS')
  if (block.source === 'SYSTEM') reasons.push('BY_SYSTEM')
  if (block.edited) reasons.push('CHANGED')
  return reasons
}

/** A block the team leader may approve with others at once: waiting, and nothing unusual about it. */
export const isNormal = (block: BlockFacts, now: Date = new Date()): boolean => block.status === 'PENDING' && unusualOf(block, now).length === 0

/** Why the reasons say what they say, in words ("longer than an hour; typed afterwards …"). */
export const unusualWords = (reasons: readonly UnusualReason[]): string => reasons.map((reason) => UNUSUAL_WORDS[reason]).join('; ')

/**
 * The time a tablet says something happened, when it can be believed: not ahead of the server (beyond a small skew) and
 * not older than half a day; otherwise the server's time. Never later than now.
 */
export function believedTime(occurredAt: Date | null | undefined, now: Date): Date {
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return now
  const delta = occurredAt.getTime() - now.getTime()
  if (delta > OFF_STANDARD_LIMITS.deviceAheadMs || -delta > OFF_STANDARD_LIMITS.deviceBehindMs) return now
  return delta > 0 ? now : occurredAt
}

/** The problems of the times of a block typed or corrected in the office, each at its field. */
export function timesProblems(input: { readonly startedAt: Date; readonly endedAt: Date }, now: Date, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (input.startedAt.getTime() > now.getTime()) problems.push({ path: `${at}/startedAt`, message: 'A block cannot start in the future.' })
  if (input.endedAt.getTime() > now.getTime() + OFF_STANDARD_LIMITS.deviceAheadMs) problems.push({ path: `${at}/endedAt`, message: 'A block cannot end in the future.' })
  if (input.endedAt.getTime() <= input.startedAt.getTime()) problems.push({ path: `${at}/endedAt`, message: 'A block ends after it starts.' })
  else if (minutesOf(input.startedAt, input.endedAt) > OFF_STANDARD_LIMITS.longestMinutes) problems.push({ path: `${at}/endedAt`, message: `A block lasts at most ${OFF_STANDARD_LIMITS.longestMinutes / 60} hours: split a longer one.` })
  return problems
}

// ---- refusals (409, in words) ------------------------------------------------------------------------------------------

export interface OffStandardRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

const STATUS_WORDS: Readonly<Record<BlockStatus, string>> = Object.freeze({ OPEN: 'still running', PENDING: 'waiting for approval', APPROVED: 'approved', REJECTED: 'rejected' })
export const statusWords = (status: BlockStatus): string => STATUS_WORDS[status]

/** Approving or rejecting a block: only a waiting one, never by a person it is about. */
export function decisionRefusal(input: { readonly status: BlockStatus; readonly involved: boolean }): OffStandardRefusal | null {
  if (input.status === 'OPEN') return { code: 'STILL_RUNNING', message: 'This block is still running.', fix: 'End it first: it waits for approval once it ended.' }
  if (input.status !== 'PENDING') return { code: 'NOT_PENDING', message: `This block is not waiting for approval: it is ${STATUS_WORDS[input.status]}.`, fix: 'Reopen it with a reason to decide it again.' }
  if (input.involved) return { code: 'OWN_TIME', message: 'You cannot decide your own time.', fix: 'Another team leader or the office decides it.' }
  return null
}

/** Reopening a decided block (→ PENDING) with a reason. */
export function reopenRefusal(status: BlockStatus): OffStandardRefusal | null {
  if (status === 'APPROVED' || status === 'REJECTED') return null
  return { code: 'NOT_DECIDED', message: `This block is ${STATUS_WORDS[status]}: only an approved or rejected block is reopened.`, fix: status === 'OPEN' ? 'End it first.' : 'Approve or reject it.' }
}

/** Correcting a block's facts: only while it waits for approval (a decided one is reopened first). */
export function correctRefusal(status: BlockStatus): OffStandardRefusal | null {
  if (status === 'PENDING') return null
  if (status === 'OPEN') return { code: 'STILL_RUNNING', message: 'This block is still running.', fix: 'End it first, then correct it.' }
  return { code: 'NOT_PENDING', message: `This block is ${STATUS_WORDS[status]}.`, fix: 'Reopen it with a reason, then correct it.' }
}

/** Ending a block from the office: only a running one. */
export function endRefusal(status: BlockStatus): OffStandardRefusal | null {
  if (status === 'OPEN') return null
  return { code: 'NOT_RUNNING', message: `This block is not running: it is ${STATUS_WORDS[status]}.`, fix: 'Nothing to end.' }
}

export const NONE_RUNNING: OffStandardRefusal = Object.freeze({ code: 'NONE_RUNNING', message: 'No off-standard time is running here.', fix: 'Pick a tile to start one, or scan a bundle to work on it.' })
export const CODE_INACTIVE: OffStandardRefusal = Object.freeze({ code: 'CODE_INACTIVE', message: 'This code is no longer used.', fix: 'Pick another tile.' })
export const BUNDLE_RUNNING: OffStandardRefusal = Object.freeze({ code: 'BUNDLE_RUNNING', message: 'A bundle is running here: off-standard time starts only when no bundle runs.', fix: 'Pause or finish the bundle first.' })
export const NO_STATION: OffStandardRefusal = Object.freeze({ code: 'NO_STATION', message: 'This site records the station, and this tablet is not placed at one.', fix: 'Ask the office to place the tablet at a station.' })
export const KIND_FIXED: OffStandardRefusal = Object.freeze({ code: 'KIND_FIXED', message: "A code's kind never changes: blocks already booked to it keep what they were.", fix: 'Make a new code of the other kind, and set this one inactive.' })

export function dayClosedRefusal(lineCode: string, workDate: string): OffStandardRefusal {
  return { code: 'DAY_CLOSED', message: `The day ${workDate} of line ${lineCode} is closed: closed days feed pay.`, fix: 'Reopen the line day with a reason first.' }
}

export function overlapRefusal(other: { readonly startedAt: Date; readonly endedAt: Date | null; readonly code: string }): OffStandardRefusal {
  const until = other.endedAt ? other.endedAt.toISOString() : 'now'
  return { code: 'OVERLAPS', message: `It overlaps another block of the same person or station (${other.code}, ${other.startedAt.toISOString()} – ${until}).`, fix: 'Change the times, or correct the other block first.' }
}

export function callsBookRefusal(types: readonly string[]): OffStandardRefusal {
  return { code: 'BOOKED_BY_CALLS', message: `Help calls ${types.join(', ')} book their waiting time to this code.`, fix: 'Point those help-call types at another code first.' }
}

/** Two time spans meet (an open span runs to `now`). */
export function overlaps(a: { readonly startedAt: Date; readonly endedAt: Date | null }, b: { readonly startedAt: Date; readonly endedAt: Date | null }, now: Date): boolean {
  const aEnd = (a.endedAt ?? now).getTime()
  const bEnd = (b.endedAt ?? now).getTime()
  return a.startedAt.getTime() < bEnd && b.startedAt.getTime() < aEnd
}

// ---- labour edits (MES-204) --------------------------------------------------------------------------------------------

type JsonValue = string | number | boolean | null

/** The fields that changed, before and after (same keys, not equal); null when nothing changed. */
export function editOf(before: Readonly<Record<string, JsonValue>>, after: Readonly<Record<string, JsonValue>>): { readonly before: Record<string, JsonValue>; readonly after: Record<string, JsonValue> } | null {
  const changedBefore: Record<string, JsonValue> = {}
  const changedAfter: Record<string, JsonValue> = {}
  for (const key of Object.keys(after)) {
    const was = key in before ? before[key]! : null
    if (was !== after[key]) {
      changedBefore[key] = was
      changedAfter[key] = after[key]!
    }
  }
  return Object.keys(changedAfter).length === 0 ? null : { before: changedBefore, after: changedAfter }
}
