import type { MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import { stageReachedWords } from '@nexus/factory-domain/sales/portal-returns/rules'
import { STAGES } from '@nexus/factory-domain/quality/capa/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { EMPTY_REPAIR_DRAFT, repairDirty, repairStartProblems, type RepairDraft } from './repair/model'
import type { Locale } from '../../../lib/i18n/locales'
import type {
  CaseChip,
  CaseItem,
  CaseType,
  ComplaintBody,
  ComplaintRecord,
  ComplaintRow,
  OutcomeWanted,
  ReturnableItem,
  ReturnableRead,
  ReturnMilestone,
  ReturnRecord,
  ReturnRequestBody,
  Words,
} from './api'
// B-W2b-346 (SAL-298, RX2:02): the remake's own checks.
import { remakeDirty, remakeStartProblems } from './remake/model'

/**
 * SCR-187 — the customer's Returns & claims (B-W2b-197; design portal.customer.returns), pure: the addresses, the tabs,
 * tones, the steps of the MilestoneTracker (a return's five, a complaint's 8D), why an action waits (in OUR words, by
 * code: never the API's sentence), the photos a person picks, the start of a return or a complaint (what the API takes,
 * why Send waits), a refusal in our words and the CSV of the selected cases. No call, no React: the containers read, the
 * views draw, these rules decide (the tests hold them).
 */

export const NS = 'portal-returns'

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// ── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const RECORD_TABS = ['request', 'status', 'messages'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
/** The record opens on Status (design rec meta "address: /p/<party>/returns/<id>?tab=status"). */
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'status')

/** The list's address: the chip (OPEN is the API's default and is left out) and the search. */
export function listQuery(chip: CaseChip | null, q: string, extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams()
  if (chip && chip !== 'OPEN') params.set('chip', chip)
  if (q.trim()) params.set('q', q.trim())
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** A case's own page: a return at `/returns/<id>`, a complaint at `/returns/complaints/<id>` (the same tabs). */
export function caseHref(prefix: string, type: CaseType, id: string, tab: RecordTab = 'status'): string {
  const base = type === 'RETURN' ? `${prefix}/returns/${encodeURIComponent(id)}` : `${prefix}/returns/complaints/${encodeURIComponent(id)}`
  return `${base}?tab=${tab}${tab === 'messages' ? '#messages' : ''}`
}

/** The record type of a case in the API's threads (its Messages). */
export const threadTypeOf = (type: CaseType): string => (type === 'RETURN' ? 'ReturnAuthorisation' : 'Complaint')

// ── tones and words by code ──────────────────────────────────────────────────────────────────────────────────────────
const RETURN_TONES: Readonly<Record<string, Tone>> = { REQUESTED: 'info', SEND_IT_BACK: 'warning', BACK_WITH_US: 'info', INSPECTED: 'info', DONE: 'success', NOT_ACCEPTED: 'danger', CANCELLED: 'neutral' }
const COMPLAINT_TONES: Readonly<Record<string, Tone>> = { RECEIVED: 'info', INVESTIGATING: 'info', ANSWERED: 'success', CLOSED: 'neutral' }

export const stateTone = (type: CaseType, state: string): Tone => (type === 'RETURN' ? RETURN_TONES[state] : COMPLAINT_TONES[state]) ?? 'neutral'

/** The state in OUR words (`state.RETURN.SEND_IT_BACK`), the API's pair only for a code this page does not know yet. */
export function stateWords(t: Translate, locale: Locale, type: CaseType, state: string, fallback: Words): string {
  const known = type === 'RETURN' ? state in RETURN_TONES : state in COMPLAINT_TONES
  return known ? t(`state.${type}.${state}`) : fallback[locale]
}

/** How the case reached us (PORTAL, LINK, OFFICE; a complaint also EMAIL, PHONE …): our words, else the code's own. */
export const VIA_CODES = ['PORTAL', 'LINK', 'OFFICE', 'EMAIL', 'PHONE'] as const
export const viaKey = (via: string): string => ((VIA_CODES as readonly string[]).includes(via) ? `via.${via}` : 'via.OTHER')

// ── the steps ────────────────────────────────────────────────────────────────────────────────────────────────────────
const SHOWN: Readonly<Record<ReturnMilestone['state'], MilestoneStep['state']>> = { DONE: 'done', CURRENT: 'current', TODO: 'todo', SKIPPED: 'skipped' }

/** A return's five steps for the DS MilestoneTracker: Asked · Decided · Back with us · Inspected · Outcome, each with its day. */
export function returnSteps(milestones: readonly ReturnMilestone[], t: Translate, at: (iso: string) => string): MilestoneStep[] {
  return milestones.map((step) => ({ id: step.step, label: t(`step.${step.step}`), state: SHOWN[step.state], current: step.state === 'CURRENT', date: step.at ? at(step.at) : null }))
}

/** A complaint's investigation steps (D1–D8, or Plan · Act · Check) for the tracker, with the day each was left or reached. */
export function disciplineSteps(steps: NonNullable<NonNullable<ComplaintRecord['investigation']>['steps']>, locale: Locale, day: (iso: string) => string): MilestoneStep[] {
  return steps.map((step) => ({ id: step.stage, label: step.words[locale], state: step.state === 'DONE' ? 'done' : step.state === 'CURRENT' ? 'current' : 'todo', current: step.state === 'CURRENT', date: step.on ? day(step.on) : null }))
}

/**
 * How far an 8D got, for the complaints list's bar (design "8D step reached"): the list names the step in words only, so the
 * words are matched against the domain's own (`stageReachedWords`) — D4 reached is 3 of 8 done, D8 closed is 8 of 8. A
 * plain CAPA (Plan · Act · Check) or an unknown step: null (words only, no bar).
 */
export function eightDProgress(stepReached: Words | null): { done: number; of: number } | null {
  if (!stepReached) return null
  const stages = STAGES.EIGHT_D
  const closed = stageReachedWords('EIGHT_D', 'CLOSED')
  if (closed && closed.en === stepReached.en) return { done: stages.length, of: stages.length }
  const at = stages.findIndex((stage) => stageReachedWords('EIGHT_D', stage)?.en === stepReached.en)
  return at >= 0 ? { done: at, of: stages.length } : null
}

// ── why an action waits (OUR words: a key of the catalogue) ─────────────────────────────────────────────────────────
export interface WhoActs {
  /** An office preview: it reads, never acts. */
  preview: boolean
  /** portal.returns.request. */
  mayRequest: boolean
  offline: boolean
}

const RETURN_OPEN = ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED']
const GOODS_BACK = ['RECEIVED', 'INSPECTED']

/** "Cancel this request?" is offered on an open return; null: it may be cancelled now. */
export const offersCancel = (record: Pick<ReturnRecord, 'status'>): boolean => RETURN_OPEN.includes(record.status)

export function cancelHeld(record: Pick<ReturnRecord, 'status' | 'actions'>, who: WhoActs & { busy?: boolean }): string | null {
  if (who.preview) return 'held.preview'
  if (!who.mayRequest) return 'held.mayRequest'
  if (GOODS_BACK.includes(record.status)) return 'held.goodsBack'
  if (!RETURN_OPEN.includes(record.status) || !record.actions.cancel.allowed) return 'held.closed'
  if (who.offline) return 'held.offline'
  if (who.busy) return 'held.busy'
  return null
}

const RETURN_PHOTOS = ['REQUESTED', 'AUTHORISED', 'RECEIVED']
const COMPLAINT_PHOTOS = ['NEW', 'TRIAGED', 'INVESTIGATING']

/** Add photos waits: why (a key), or null. `mayUpload`: the person's upload right (with the right to ask). */
export function photosHeld(type: CaseType, record: { status: string; actions: { addPhotos: { allowed: boolean } } }, who: WhoActs & { mayUpload: boolean }): string | null {
  if (who.preview) return 'held.preview'
  if (!who.mayRequest || !who.mayUpload) return 'held.mayUpload'
  const open = type === 'RETURN' ? RETURN_PHOTOS.includes(record.status) : COMPLAINT_PHOTOS.includes(record.status)
  if (!open) return type === 'RETURN' ? 'held.decided' : 'held.answered'
  if (!record.actions.addPhotos.allowed) return 'held.mayUpload'
  if (who.offline) return 'held.offline'
  return null
}

/** "Start a return or claim" waits: why, or null. */
export function startHeld(who: WhoActs): string | null {
  if (who.preview) return 'held.preview'
  if (!who.mayRequest) return 'held.mayRequest'
  if (who.offline) return 'held.offline'
  return null
}

// ── photos ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What the API takes (modules/sales/portal-returns/files.ts): a photo, at most 15 MB, at most 10 on one case. */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const
export const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,.heic'
export const PHOTO_MAX_BYTES = 15 * 1_048_576
export const PHOTOS_PER_CASE = 10

export interface PickedPhoto {
  id: string
  name: string
  type: string
  size: number
  state: 'waiting' | 'sending' | 'sent' | 'failed'
  /** Why it cannot go or did not go (a key). */
  problem: string | null
}

/** A picked file's problem before anything is sent (a key), or null. */
export function photoProblem(file: { type: string; size: number }): string | null {
  const type = file.type.toLowerCase()
  if (!(PHOTO_TYPES as readonly string[]).includes(type === 'image/jpg' ? 'image/jpeg' : type)) return 'photos.problem.type'
  if (file.size > PHOTO_MAX_BYTES) return 'photos.problem.size'
  return null
}

/** How many more photos the target takes (the API counts each record: the request, one line, the complaint). */
export function photosLeft(already: number, picked: readonly PickedPhoto[]): number {
  return Math.max(0, PHOTOS_PER_CASE - already - picked.filter((photo) => photo.state !== 'failed' && photo.problem === null).length)
}

/** Send waits: why (a key), or null. */
export function sendPhotosHeld(picked: readonly PickedPhoto[], held: string | null, busy: boolean): string | null {
  if (held) return held
  if (busy) return 'held.busy'
  if (!picked.some((photo) => photo.state === 'waiting' && photo.problem === null)) return 'photos.held.none'
  return null
}

// ── start a return or a claim ────────────────────────────────────────────────────────────────────────────────────────
export type StartStep = 'type' | 'details' | 'review'
/** B-W2b-342 / B-W2b-346: what the start asks — a return, a quality complaint, a repair or alteration (./repair) or a remake (SAL-298, RX2:02; remake/model.ts). */
export type StartType = CaseType | 'REMAKE' | 'REPAIR'
export interface StartLine {
  picked: boolean
  quantity: string
  reasonCode: string
  reasonNote: string
  serial: string
}
export interface StartDraft extends RepairDraft {
  step: StartStep
  type: StartType | null
  lines: Readonly<Record<string, StartLine>>
  outcomeWanted: OutcomeWanted | null
  customerRef: string
  note: string
  /** The complaint: the item (a returnable key) or none, and what they tell us. */
  itemKey: string
  serial: string
  batchNumber: string
  description: string
  /** B-W2b-346 REMAKE: the one item (a returnable key) and what is wrong with the fit (the serial is `serial`). */
  remakeKey: string
  fit: string
  /** Next was pressed with problems: they show at their fields. */
  tried: boolean
}

export const EMPTY_START: StartDraft = { step: 'type', type: null, lines: {}, outcomeWanted: null, customerRef: '', note: '', itemKey: '', serial: '', batchNumber: '', description: '', remakeKey: '', fit: '', tried: false, ...EMPTY_REPAIR_DRAFT }

export const LIMITS = { reasonNote: 500, serial: 60, customerRef: 80, note: 2000, description: 4000, batchNumber: 60, lines: 50 } as const

export const startLineOf = (draft: StartDraft, key: string): StartLine => draft.lines[key] ?? { picked: false, quantity: '1', reasonCode: '', reasonNote: '', serial: '' }

const whole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null)

/** The problems of a draft at its fields (`type`, `lines`, `<key>.quantity|reasonCode|reasonNote|serial`, `description` …). */
export function startProblems(draft: StartDraft, read: ReturnableRead | null): Record<string, string> {
  const problems: Record<string, string> = {}
  if (!draft.type) problems.type = 'start.problem.type'
  if (draft.type === 'RETURN') {
    const picked = Object.entries(draft.lines).filter(([, line]) => line.picked)
    if (picked.length === 0) problems.lines = 'start.problem.lines'
    if (picked.length > LIMITS.lines) problems.lines = 'start.problem.tooManyLines'
    for (const [key, line] of picked) {
      const item = read?.items.find((entry) => entry.key === key)
      const quantity = whole(line.quantity)
      if (quantity === null || quantity < 1) problems[`${key}.quantity`] = 'start.problem.quantity'
      else if (item && quantity > item.canReturn) problems[`${key}.quantity`] = 'start.problem.tooMany'
      if (!line.reasonCode) problems[`${key}.reasonCode`] = 'start.problem.reason'
      const reason = read?.reasons.find((entry) => entry.code === line.reasonCode)
      if (reason?.needsNote && line.reasonNote.trim() === '') problems[`${key}.reasonNote`] = 'start.problem.reasonNote'
      if (line.reasonNote.trim().length > LIMITS.reasonNote) problems[`${key}.reasonNote`] = 'start.problem.long'
      if (line.serial.trim().length > LIMITS.serial) problems[`${key}.serial`] = 'start.problem.long'
    }
    if (draft.note.trim().length > LIMITS.note) problems.note = 'start.problem.long'
  }
  if (draft.type === 'COMPLAINT') {
    if (draft.description.trim() === '') problems.description = 'start.problem.description'
    if (draft.description.trim().length > LIMITS.description) problems.description = 'start.problem.long'
    if (draft.serial.trim().length > LIMITS.serial) problems.serial = 'start.problem.long'
    if (draft.batchNumber.trim().length > LIMITS.batchNumber) problems.batchNumber = 'start.problem.long'
  }
  // B-W2b-342: the repair's fields (their keys name the returns-repair catalogue).
  if (draft.type === 'REPAIR') Object.assign(problems, repairStartProblems(draft, read))
  if (draft.customerRef.trim().length > LIMITS.customerRef) problems.customerRef = 'start.problem.long'
  // B-W2b-346: a remake's own problems (keys of `returns-remake`).
  if (draft.type === 'REMAKE') Object.assign(problems, remakeStartProblems(draft, read))
  return problems
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim())

/** What POST /portal/returns takes from the draft (the picked items, each with its pieces and reason). */
export function returnBodyOf(draft: StartDraft, read: ReturnableRead): ReturnRequestBody {
  const lines = read.items.flatMap((item) => {
    const line = draft.lines[item.key]
    if (!line?.picked) return []
    return [{ invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, quantity: whole(line.quantity) ?? 0, reasonCode: line.reasonCode, reasonNote: orNull(line.reasonNote), serial: orNull(line.serial) }]
  })
  return { lines, outcomeWanted: draft.outcomeWanted, customerRef: orNull(draft.customerRef), note: orNull(draft.note) }
}

/** What POST /portal/complaints takes (the item: an order line of the party, with its size). */
export function complaintBodyOf(draft: StartDraft, read: ReturnableRead | null): ComplaintBody {
  const item = read?.items.find((entry) => entry.key === draft.itemKey) ?? null
  return { description: draft.description.trim(), salesOrderLineId: item?.salesOrderLineId ?? null, size: item?.size ?? null, serial: orNull(draft.serial), batchNumber: orNull(draft.batchNumber), customerRef: orNull(draft.customerRef) }
}

/** The draft holds typed work (closing asks Discard / Stay; leaving the page asks first). */
export const startDirty = (draft: StartDraft): boolean =>
  draft.type !== null &&
  (Object.values(draft.lines).some((line) => line.picked) || repairDirty(draft) || remakeDirty(draft) || draft.customerRef.trim() !== '' || draft.note.trim() !== '' || draft.description.trim() !== '' || draft.serial.trim() !== '' || draft.batchNumber.trim() !== '' || draft.outcomeWanted !== null || draft.itemKey !== '')

/** The next step of the start, or the problems that hold it (shown at their fields). */
export function nextStep(draft: StartDraft, read: ReturnableRead | null): { step: StartStep } | { problems: Record<string, string> } {
  if (draft.step === 'type') return draft.type ? { step: 'details' } : { problems: { type: 'start.problem.type' } }
  const problems = startProblems(draft, read)
  return Object.keys(problems).length > 0 ? { problems } : { step: 'review' }
}

/** Send waits: why (a key), or null. */
export function sendHeld(draft: StartDraft, read: ReturnableRead | null, who: WhoActs & { busy: boolean }): string | null {
  const held = startHeld(who)
  if (held) return held
  if (!read) return 'held.reading'
  if (who.busy) return 'held.busy'
  if (Object.keys(startProblems(draft, read)).length > 0) return 'start.held.problems'
  return null
}

/** An item a person may pick for a return: its pieces still returnable (0: shown, not pickable, with the reason). */
export const pickable = (item: Pick<ReturnableItem, 'canReturn'>): boolean => item.canReturn > 0

/** An item's line under its name: order and line, size, colourway. */
export function itemFacts(item: ReturnableItem, t: Translate): string[] {
  return [
    item.order ? t('start.orderLine', { number: item.order.number, line: item.order.lineSeq }) : null,
    item.invoice?.number ? t('start.invoice', { number: item.invoice.number }) : null,
    item.size ? t('item.size', { size: item.size }) : null,
    item.colourway ? item.colourway.name : null,
  ].filter((part): part is string => part !== null)
}

// ── a refusal in our words ───────────────────────────────────────────────────────────────────────────────────────────
/** The key of what went wrong with a write (the API's English message is for logs). */
export function refusalKey(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.missing'
  if (error.kind === 'conflict') {
    if (error.issues.some((issue) => /quantity$/.test(issuePath(issue)))) return 'start.problem.tooManyNow'
    return 'problem.changed'
  }
  if (error.kind === 'invalid') {
    if (error.issues.some((issue) => /contentType$/.test(issuePath(issue)))) return 'photos.problem.type'
    if (error.issues.some((issue) => /sizeBytes$/.test(issuePath(issue)))) return 'photos.problem.size'
    return 'problem.invalid'
  }
  if (error.kind === 'rate_limited') return 'problem.tooMany'
  if (error.kind === 'unavailable') return 'problem.unavailable'
  if (error.kind === 'signed_out') return 'problem.signedOut'
  return 'problem.internal'
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The item cell's one line: the first item with its size and serial, and "+ N more". */
export function itemLine(item: CaseItem, t: Translate): { main: string; more: string | null } {
  const first = item.items[0]
  if (!first) return { main: '—', more: null }
  const facts = [first.description, first.size ? t('item.size', { size: first.size }) : null, first.serial ? t('item.serial', { serial: first.serial }) : null].filter(Boolean).join(' · ')
  const rest = item.lines - 1
  return { main: facts, more: rest > 0 ? t('item.more', { count: rest }) : null }
}

const csvCell = (value: string): string => (/[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** The selected cases as CSV (Export N): the columns the list shows, in the page's language; no money on this page. */
export function casesCsv(rows: readonly CaseItem[], t: Translate, locale: Locale, at: (iso: string) => string): string {
  const head = [t('col.case'), t('col.yourRef'), t('col.type'), t('col.item'), t('col.opened'), t('col.status'), t('col.next'), t('col.updated')]
  const body = rows.map((row) => {
    const item = itemLine(row, t)
    return [row.number, row.yourRef ?? '', t(`type.${row.type}`), [item.main, item.more].filter(Boolean).join(' '), at(row.opened), stateWords(t, locale, row.type, row.state, row.words), row.next.words[locale], at(row.lastUpdate)]
  })
  return [head, ...body].map((cells) => cells.map(csvCell).join(';')).join('\n')
}

/** The Quality list's "answer due" cell: answered on, due on, or none. */
export function answerCell(row: Pick<ComplaintRow, 'answerDueOn' | 'answeredAt'>, t: Translate, day: (iso: string) => string, at: (iso: string) => string): string {
  if (row.answeredAt) return t('complaints.answeredOn', { date: at(row.answeredAt) })
  if (row.answerDueOn) return t('complaints.dueOn', { date: day(row.answerDueOn) })
  return '—'
}

/** The return's line a numbered inspection result belongs to. */
export const lineBySeq = (record: ReturnRecord, seq: number) => record.request.lines.find((line) => line.seq === seq) ?? null

/** The complaint's status in customer words' code (the Quality list carries the office status). */
export function complaintStateOfStatus(status: string): string {
  if (status === 'NEW') return 'RECEIVED'
  if (status === 'TRIAGED' || status === 'INVESTIGATING') return 'INVESTIGATING'
  return status
}

/**
 * Where a complaint is, in customer words (design rec Status "Where it is" for a complaint): Received · Being investigated ·
 * Answered · Closed — the day it reached us and the day we answered; a complaint closed without our letter skips Answered.
 */
export function complaintSteps(record: Pick<ComplaintRecord, 'status' | 'request' | 'progress'>, t: Translate, at: (iso: string) => string): MilestoneStep[] {
  const answered = record.progress.answeredAt
  const closed = record.status === 'CLOSED'
  const investigating = record.status === 'NEW' || record.status === 'TRIAGED' || record.status === 'INVESTIGATING'
  return [
    { id: 'RECEIVED', label: t('step.RECEIVED'), state: 'done', date: at(record.request.opened) },
    { id: 'INVESTIGATING', label: t('step.INVESTIGATING'), state: investigating ? 'current' : 'done', current: investigating },
    { id: 'ANSWERED', label: t('step.ANSWERED'), state: answered ? 'done' : closed ? 'skipped' : 'todo', date: answered ? at(answered) : null },
    { id: 'CLOSED', label: t('step.CLOSED'), state: closed ? 'done' : record.status === 'ANSWERED' ? 'current' : 'todo', current: record.status === 'ANSWERED' },
  ]
}
