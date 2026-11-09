import type { SizeGridValue } from '@nexus/ui/grid/size-grid/index'
import { gridOf, type GridShape } from '../../../lib/jobs/grid'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { AcceptBody, DeclineBody, DeclineReason, Job, JobAct, JobChip, JobOperation, JobRow, JobState, KitBody, KitLine, NextStep, ProgressBody, ReturnBody } from './api'

/**
 * SCR-192 / SCR-193 — a workshop's Jobs (design portal.supplier.jobs; B-W2b-181 on B-W2b-176's API), pure: the chips and
 * the cards, the record's tabs and the one next step, why each act is held (the person first — a preview, a missing
 * capability, no connection —, then the job's facts, in OUR words: the API says only whether), the drafts of each act,
 * what each write sends, a refusal in words and the end of each act. No fee, price, cost or amount anywhere (Owner answer
 * C2). Words are keys of `portal-jobs`; the views translate.
 */

export const NS = 'portal-jobs'
export type { GridShape }

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
/** A key of `portal-jobs` with its figures. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const words = (key: string, params?: Readonly<Record<string, string | number>>): Words => (params ? { key, params } : { key })

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const STATE_TONE: Readonly<Record<JobState, Tone>> = {
  TO_ANSWER: 'warning',
  DECLINED: 'danger',
  WAITING_KIT: 'info',
  IN_WORK: 'info',
  PARTLY_BACK: 'info',
  BACK: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
}

/** The list's address: `?chip=` (left out for the API's own default) and `?q=`. */
export function listQuery(chip: JobChip | null, q: string): string {
  const search = new URLSearchParams()
  if (chip) search.set('chip', chip)
  if (q.trim()) search.set('q', q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

// ── the record ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const RECORD_TABS = ['kit', 'progress', 'sendback', 'documents', 'messages'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const isRecordTab = (value: unknown): value is RecordTab => typeof value === 'string' && (RECORD_TABS as readonly string[]).includes(value)

/** The tab a job opens on: where its one next step is done. */
export function tabFor(next: NextStep): RecordTab {
  if (next === 'CONFIRM_KIT') return 'kit'
  if (next === 'SEND_BACK') return 'sendback'
  return 'progress'
}

/** `/p/<party>/jobs/<id>?tab=…` (no tab: the job's own next step decides). */
export const jobHref = (prefix: string, id: string, tab?: RecordTab | null): string => `${prefix}/jobs/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`
/** The job sheet, for the bench (a new tab: the browser prints it or saves it as a PDF). */
export const sheetHref = (prefix: string, id: string): string => `${prefix}/jobs/${encodeURIComponent(id)}/sheet`

/** The one button of a card: what the next step does (null: no button — waiting for our kit, or nothing to do). */
export function cardStepOf(row: Pick<JobRow, 'id' | 'nextStep'>, prefix: string): { kind: 'accept' } | { kind: 'open'; href: string } | null {
  switch (row.nextStep) {
    case 'ACCEPT':
      return { kind: 'accept' }
    case 'CONFIRM_KIT':
    case 'REPORT':
    case 'SEND_BACK':
      return { kind: 'open', href: jobHref(prefix, row.id, tabFor(row.nextStep)) }
    default:
      return null
  }
}

/** The days left to the due-back day (negative: late), counted on calendar days. */
export function daysLeft(dueBack: string | null, today: string): number | null {
  if (!dueBack) return null
  const ms = Date.parse(`${dueBack.slice(0, 10)}T12:00:00Z`) - Date.parse(`${today.slice(0, 10)}T12:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/** The due-back line of a card: late, today, in N days, or no day yet. */
export function dueOf(row: Pick<JobRow, 'dueBack' | 'late' | 'state'>, today: string): { key: string; days: number; tone: Tone } {
  const left = daysLeft(row.dueBack, today)
  if (row.state === 'BACK' || row.state === 'CLOSED' || row.state === 'CANCELLED' || row.state === 'DECLINED') return { key: 'due.ended', days: 0, tone: 'neutral' }
  if (left === null) return { key: 'due.none', days: 0, tone: 'neutral' }
  if (row.late || left < 0) return { key: 'due.late', days: Math.abs(left), tone: 'danger' }
  if (left === 0) return { key: 'due.today', days: 0, tone: 'warning' }
  return { key: 'due.in', days: left, tone: left <= 2 ? 'warning' : 'neutral' }
}

/** The operations of a card, in one line ("Stitching, Edge painting"). */
export const operationsOf = (row: Pick<JobRow, 'operations'>): string => row.operations.map((operation) => operation.name || operation.code).join(', ')

// ── why an act is held ───────────────────────────────────────────────────────────────────────────────────────────────
export type ActName = 'accept' | 'decline' | 'kit' | 'progress' | 'sendBack' | 'photo' | 'problem'

export interface PersonFacts {
  /** An office preview reads; it never acts. */
  readonly preview: boolean
  readonly offline: boolean
  readonly busy: boolean
  /** The capabilities of the person's role (B-W2b-162): approve, comment, upload. */
  readonly mayAct: { readonly approve: boolean; readonly comment: boolean; readonly upload: boolean }
}

/** The capability each act takes (the API's own: accept, decline and the kit check approve; reports comment; photos upload). */
const CAPABILITY: Readonly<Record<ActName, 'approve' | 'comment' | 'upload'>> = {
  accept: 'approve',
  decline: 'approve',
  kit: 'approve',
  progress: 'comment',
  sendBack: 'comment',
  photo: 'upload',
  problem: 'comment',
}

/** The order's statuses after which a job takes no act (the domain's ENDED). */
const ENDED_STATUSES: readonly string[] = ['RECEIVED', 'CLOSED', 'CANCELLED']

/** Why the job does not take this act now (from its facts; null: it may). Mirrors the domain's `jobActsOf`. */
export function jobHeld(job: Pick<Job, 'state' | 'status' | 'answer' | 'acts' | 'kit' | 'operations'>, act: ActName): Words | null {
  const ended = ENDED_STATUSES.includes(job.status)
  if (act === 'problem') return ended ? words('held.ended') : null
  if (act === 'photo') {
    if (ended) return words('held.ended')
    return job.kit.lines.some((line) => line.status === 'SENT') ? null : words('held.noKitYet')
  }
  if (!job.acts[act]) return null
  if (ended) return words('held.ended')
  if (job.answer.declinedAt) return words('held.declined')
  if (act === 'accept' || act === 'decline') {
    if (job.answer.acceptedAt) return words('held.answered')
    if (act === 'decline' && job.status === 'PARTLY_RECEIVED') return words('held.declinePartly')
    return words('held.notSent')
  }
  if (!job.answer.acceptedAt) return words('held.acceptFirst')
  if (act === 'kit') return words('held.kitNone')
  if (act === 'sendBack') return job.status === 'ISSUED' ? words('held.noKitYet') : words('held.nothingToAnnounce')
  return words('held.generic')
}

/** Why the PERSON cannot act now (preview, capability, offline, busy), or null. */
export function personHeld(facts: PersonFacts, act: ActName): Words | null {
  if (facts.preview) return words('held.preview')
  if (!facts.mayAct[CAPABILITY[act]]) return words(`held.may.${CAPABILITY[act]}`)
  if (facts.offline) return words('held.offline')
  if (facts.busy) return words('held.busy')
  return null
}

/** Why an act's button waits: the person first, then the job. */
export const actHeld = (job: Parameters<typeof jobHeld>[0], facts: PersonFacts, act: ActName): Words | null => personHeld(facts, act) ?? jobHeld(job, act)

// ── accept and decline ───────────────────────────────────────────────────────────────────────────────────────────────
export interface AcceptDraft {
  mode: 'asked' | 'move'
  proposedDate: string
  reason: string
}
export const ACCEPT_DRAFT: AcceptDraft = { mode: 'asked', proposedDate: '', reason: '' }

const blank = (text: string): boolean => text.trim() === ''
const isDay = (text: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(text)

/** Why "Accept job" waits (the draft's own rule; the person's comes first in the view). */
export function acceptHeld(draft: AcceptDraft, job: Pick<Job, 'orderDate' | 'expectedBackDate'>, today: string): Words | null {
  if (draft.mode === 'asked') return null
  if (!isDay(draft.proposedDate)) return words('accept.held.date')
  if (draft.proposedDate < today || draft.proposedDate < job.orderDate) return words('accept.held.past')
  if (draft.proposedDate === job.expectedBackDate) return words('accept.held.same')
  if (blank(draft.reason)) return words('accept.held.reason')
  return null
}

export const acceptBody = (draft: AcceptDraft): AcceptBody => (draft.mode === 'move' ? { proposedDate: draft.proposedDate, reason: draft.reason.trim() } : {})

export interface DeclineDraft {
  reason: DeclineReason | ''
  note: string
}
export const DECLINE_DRAFT: DeclineDraft = { reason: '', note: '' }

export function declineHeld(draft: DeclineDraft): Words | null {
  if (!draft.reason) return words('decline.held.reason')
  if (draft.reason === 'OTHER' && blank(draft.note)) return words('decline.held.note')
  return null
}

export const declineBody = (draft: DeclineDraft): DeclineBody => ({ reason: draft.reason as DeclineReason, ...(blank(draft.note) ? {} : { note: draft.note.trim() }) })

// ── the kit ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Kit lines that left us and wait for the workshop's count. */
export const kitToCount = (job: Pick<Job, 'kit'>): KitLine[] => job.kit.lines.filter((line) => line.status === 'SENT' && line.check === null)

export interface KitDraft {
  /** Line by line (the big "All received as listed" sends without a draft). */
  lines: Readonly<Record<string, { quantity: string; note: string }>>
}

export const kitDraftOf = (job: Pick<Job, 'kit'>): KitDraft => ({ lines: Object.fromEntries(kitToCount(job).map((line) => [line.id, { quantity: plain(line.quantity), note: '' }])) })

const QUANTITY = /^\d{1,14}([.,]\d{1,4})?$/
const decimal = (text: string): string => text.trim().replace(',', '.')

/** Why "Send the count" waits: every line counted (0 or more, at most what we sent), a shortfall said in words. */
export function kitHeld(draft: KitDraft, job: Pick<Job, 'kit'>): Words | null {
  const lines = kitToCount(job)
  if (lines.length === 0) return words('held.kitNone')
  for (const line of lines) {
    const entry = draft.lines[line.id]
    if (!entry || !QUANTITY.test(entry.quantity.trim())) return words('kit.held.count', { line: line.seq })
    const counted = Number(decimal(entry.quantity))
    const sent = Number(line.quantity)
    if (counted > sent) return words('kit.held.more', { line: line.seq, sent: plain(line.quantity) })
    if (counted < sent && blank(entry.note)) return words('kit.held.note', { line: line.seq })
  }
  return null
}

/** A line counted short (the note is asked for it). */
export function isShort(entry: { quantity: string } | undefined, line: Pick<KitLine, 'quantity'>): boolean {
  if (!entry || !QUANTITY.test(entry.quantity.trim())) return false
  return Number(decimal(entry.quantity)) < Number(line.quantity)
}

export const kitAllAct = (): JobAct => ({ act: 'kit', body: { all: true } })

export function kitLinesAct(draft: KitDraft, job: Pick<Job, 'kit'>): JobAct {
  const body: KitBody = {
    lines: kitToCount(job).map((line) => {
      const entry = draft.lines[line.id] ?? { quantity: line.quantity, note: '' }
      return { kitLineId: line.id, quantity: decimal(entry.quantity), ...(blank(entry.note) ? {} : { note: entry.note.trim() }) }
    }),
  }
  return { act: 'kit', body }
}

// ── progress ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One operation's size grid (src/lib/jobs: the link draws the same). */
export const operationGrid = (operation: Pick<JobOperation, 'sizes'>): GridShape => gridOf(operation.sizes)

export interface ProgressDraft {
  /** Today's finished pieces per operation: its size grid (colourway → size → pieces), or the whole operation. */
  grids: Readonly<Record<string, SizeGridValue>>
  whole: Readonly<Record<string, string>>
  finishBy: string
  note: string
}

export const progressDraftOf = (job: Pick<Job, 'finishBy'>): ProgressDraft => ({ grids: {}, whole: {}, finishBy: job.finishBy ?? '', note: '' })

const WHOLE = /^\d{1,6}$/

/** Today's pieces of one operation in the draft. */
export function draftPieces(draft: ProgressDraft, operation: Pick<JobOperation, 'id' | 'sizes'>): number {
  if (operation.sizes.length === 0) {
    const text = draft.whole[operation.id] ?? ''
    return WHOLE.test(text.trim()) ? Number(text.trim()) : 0
  }
  const grid = draft.grids[operation.id] ?? {}
  return Object.values(grid).reduce((sum, row) => sum + Object.values(row).reduce((inner, value) => inner + (Number.isFinite(value) ? value : 0), 0), 0)
}

/** Why "Send report" waits: whole pieces, never past what is left of a cell or the operation, at least one piece. */
export function progressHeld(draft: ProgressDraft, job: Pick<Job, 'operations' | 'orderDate'>): Words | null {
  let total = 0
  for (const operation of job.operations) {
    if (operation.sizes.length === 0) {
      const text = (draft.whole[operation.id] ?? '').trim()
      if (text !== '' && !WHOLE.test(text)) return words('progress.held.whole', { line: operation.seq })
    }
    for (const cell of operation.sizes) {
      const value = draft.grids[operation.id]?.[cell.colourway]?.[cell.size] ?? 0
      if (value > cell.pieces - cell.finished) return words('progress.held.cell', { line: operation.seq, size: `${cell.colourway} ${cell.size}`, left: Math.max(0, cell.pieces - cell.finished) })
    }
    const today = draftPieces(draft, operation)
    if (operation.finished + today > operation.pieces) return words('progress.held.operation', { line: operation.seq, left: Math.max(0, operation.pieces - operation.finished) })
    total += today
  }
  if (total === 0) return words('progress.held.nothing')
  if (draft.finishBy && (!isDay(draft.finishBy) || draft.finishBy < job.orderDate)) return words('progress.held.finishBy')
  return null
}

export function progressAct(draft: ProgressDraft, job: Pick<Job, 'operations'>): JobAct {
  const entries: ProgressBody['entries'] = []
  for (const operation of job.operations) {
    if (operation.sizes.length === 0) {
      const count = draftPieces(draft, operation)
      if (count > 0) entries.push({ operationId: operation.id, finished: count })
      continue
    }
    for (const cell of operation.sizes) {
      const count = draft.grids[operation.id]?.[cell.colourway]?.[cell.size] ?? 0
      if (count > 0) entries.push({ operationId: operation.id, workOrderSizeId: cell.workOrderSizeId, finished: count })
    }
  }
  const body: ProgressBody = { entries, ...(draft.finishBy ? { finishBy: draft.finishBy } : {}), ...(blank(draft.note) ? {} : { note: draft.note.trim() }) }
  return { act: 'progress', body }
}

export const progressTyped = (draft: ProgressDraft, job: Pick<Job, 'operations'>): number => job.operations.reduce((sum, operation) => sum + draftPieces(draft, operation), 0)

// ── send back ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ReturnDraft {
  rows: Readonly<Record<string, { finished: string; scrapped: string; reasonCode: string }>>
  material: Readonly<Record<string, string>>
  parcels: string
  expectedDate: string
  weCollect: boolean
  ddtNumber: string
  ddtDate: string
  note: string
}

/** A fresh send-back: what is finished and still with the workshop, one parcel, today, the workshop delivers. */
export const returnDraftOf = (job: Pick<Job, 'operations'>, today: string): ReturnDraft => ({
  rows: Object.fromEntries(job.operations.filter((operation) => operation.announceable > 0).map((operation) => [operation.id, { finished: String(Math.min(operation.ready, operation.announceable)), scrapped: '0', reasonCode: '' }])),
  material: {},
  parcels: '1',
  expectedDate: today,
  weCollect: false,
  ddtNumber: '',
  ddtDate: '',
  note: '',
})

const count = (text: string): number => (WHOLE.test(text.trim() || '0') ? Number(text.trim() || '0') : Number.NaN)

/** The pieces the draft sends back (finished and scrapped). */
export function returnPieces(draft: ReturnDraft): { finished: number; scrapped: number } {
  let finished = 0
  let scrapped = 0
  for (const row of Object.values(draft.rows)) {
    finished += Number.isNaN(count(row.finished)) ? 0 : count(row.finished)
    scrapped += Number.isNaN(count(row.scrapped)) ? 0 : count(row.scrapped)
  }
  return { finished, scrapped }
}

export function returnHeld(draft: ReturnDraft, job: Pick<Job, 'operations' | 'kit'>, today: string): Words | null {
  let pieces = 0
  for (const [operationId, row] of Object.entries(draft.rows)) {
    const operation = job.operations.find((entry) => entry.id === operationId)
    if (!operation) continue
    const finished = count(row.finished)
    const scrapped = count(row.scrapped)
    if (Number.isNaN(finished) || Number.isNaN(scrapped)) return words('returns.held.whole', { line: operation.seq })
    if (scrapped > 0 && !row.reasonCode) return words('returns.held.reason', { line: operation.seq })
    if (finished + scrapped > operation.announceable) return words('returns.held.more', { line: operation.seq, left: operation.announceable })
    pieces += finished + scrapped
  }
  if (pieces === 0) return words('returns.held.nothing')
  for (const [kitLineId, text] of Object.entries(draft.material)) {
    if (blank(text)) continue
    const line = job.kit.lines.find((entry) => entry.id === kitLineId)
    if (!QUANTITY.test(text.trim()) || Number(decimal(text)) <= 0) return words('returns.held.material', { line: line?.seq ?? 0 })
    if (line && Number(decimal(text)) > Number(line.quantity)) return words('returns.held.materialMore', { line: line.seq, sent: plain(line.quantity) })
  }
  if (!WHOLE.test(draft.parcels.trim()) || Number(draft.parcels) < 1 || Number(draft.parcels) > 9999) return words('returns.held.parcels')
  if (!isDay(draft.expectedDate) || draft.expectedDate < today) return words('returns.held.day')
  if (draft.ddtDate && blank(draft.ddtNumber)) return words('returns.held.ddtNumber')
  if (draft.ddtDate && draft.ddtDate > draft.expectedDate) return words('returns.held.ddtDate')
  return null
}

export function returnAct(draft: ReturnDraft): JobAct {
  const quantities: ReturnBody['quantities'] = Object.entries(draft.rows)
    .map(([operationId, row]) => ({ operationId, finished: count(row.finished) || 0, scrapped: count(row.scrapped) || 0, reasonCode: row.reasonCode }))
    .filter((row) => row.finished + row.scrapped > 0)
    .map(({ reasonCode, scrapped, ...row }) => (scrapped > 0 ? { ...row, scrapped, reasonCode } : { ...row, scrapped: 0 }))
  const materialBack = Object.entries(draft.material)
    .filter(([, text]) => !blank(text))
    .map(([kitLineId, text]) => ({ kitLineId, quantity: decimal(text) }))
  const body: ReturnBody = {
    quantities,
    ...(materialBack.length > 0 ? { materialBack } : {}),
    parcels: Number(draft.parcels.trim()),
    expectedDate: draft.expectedDate,
    weCollect: draft.weCollect,
    ...(blank(draft.ddtNumber) ? {} : { ddt: { number: draft.ddtNumber.trim(), ...(draft.ddtDate ? { date: draft.ddtDate } : {}) } }),
    ...(blank(draft.note) ? {} : { note: draft.note.trim() }),
  }
  return { act: 'returns', body }
}

// ── report a problem (a post in the job's messages) ─────────────────────────────────────────────────────────────────
export const PROBLEM_KINDS = ['MATERIAL', 'DEFECT', 'MACHINE', 'OTHER'] as const
export type ProblemKind = (typeof PROBLEM_KINDS)[number]
export interface ProblemDraft {
  kind: ProblemKind | ''
  note: string
}
export const PROBLEM_DRAFT: ProblemDraft = { kind: '', note: '' }

export function problemHeld(draft: ProblemDraft): Words | null {
  if (!draft.kind) return words('problem.held.kind')
  if (blank(draft.note)) return words('problem.held.note')
  return null
}

/** The post: the kind in the workshop's own language, then its words (the office reads the thread). */
export const problemText = (draft: ProblemDraft, t: (key: string) => string): string => `${t(`problem.kind.${draft.kind}`)} — ${draft.note.trim()}`

// ── the end of an act, in our words ──────────────────────────────────────────────────────────────────────────────────
export type ActEnd =
  | { kind: 'accepted'; proposedDate: string | null; kitDay: string | null }
  | { kind: 'declined' }
  | { kind: 'kit'; lines: number; short: number }
  | { kind: 'progress'; pieces: number }
  | { kind: 'returns'; pieces: number; day: string }
  | { kind: 'photo'; name: string }
  | { kind: 'problem' }

export function endWords(end: ActEnd): Words {
  switch (end.kind) {
    case 'accepted':
      if (end.proposedDate) return words('end.acceptedMoved', { date: end.proposedDate })
      return end.kitDay ? words('end.acceptedKit', { date: end.kitDay }) : words('end.accepted')
    case 'declined':
      return words('end.declined')
    case 'kit':
      return end.short === 0 ? words('end.kit', { count: end.lines }) : words('end.kitShort', { count: end.short })
    case 'progress':
      return words('end.progress', { count: end.pieces })
    case 'returns':
      return words('end.returns', { count: end.pieces, date: end.day })
    case 'photo':
      return words('end.photo', { name: end.name })
    case 'problem':
      return words('end.problem')
  }
}

/** The last day our kit left (the accepted end: "we send the kit on …"). */
export const kitDayOf = (job: Pick<Job, 'kit'>): string | null => job.kit.sentOn.at(-1) ?? null

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A write's refusal in words: the field it names first, then its kind. Never the API's English sentence. */
export function writeProblem(error: unknown): Words {
  if (!isApiError(error)) return words('problem.write')
  const paths = error.issues.map((issue) => issuePath(issue))
  const has = (part: string) => paths.some((path) => path.includes(part))
  if (error.kind === 'invalid') {
    if (has('proposedDate')) return words('refused.proposedDate')
    if (has('reasonCode')) return words('refused.scrapReason')
    if (has('note')) return words('refused.note')
    if (has('reason')) return words('refused.reason')
    if (has('lines') || has('kitLineId')) return words('refused.kit')
    if (has('entries')) return words('refused.progress')
    if (has('materialBack')) return words('refused.material')
    if (has('quantities')) return words('refused.returns')
    if (has('parcels')) return words('refused.parcels')
    if (has('expectedDate')) return words('refused.day')
    if (has('ddt')) return words('refused.ddt')
    if (has('contentType') || has('sizeBytes')) return words('refused.photo')
    return words('problem.invalid')
  }
  if (error.kind === 'conflict') return error.code === 'stale_version' || /version|changed/i.test(error.message) ? words('problem.changed') : words('problem.state')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return words('problem.forbidden')
  if (error.kind === 'unavailable') return words('problem.offline')
  if (error.kind === 'rate_limited') return words('problem.slowDown')
  if (error.kind === 'not_found') return words('problem.gone')
  return words('problem.write')
}

// ── small writers ────────────────────────────────────────────────────────────────────────────────────────────────────
/** "12.6000" → "12.6". */
export function plain(quantity: string): string {
  if (!quantity.includes('.')) return quantity
  return quantity.replace(/0+$/, '').replace(/\.$/, '')
}

/** A quantity in the page's language ("12,5" in Italian). */
export const quantityIn = (quantity: string, locale: string): string => (locale === 'it' ? plain(quantity).replace('.', ',') : plain(quantity))

/** The scrap reasons the job offers, their words ours: `scrap.<code>` (a code we do not know is said as "Other reason"). */
export const KNOWN_SCRAP = ['LEATHER_FLAW', 'CUT_WRONG', 'STITCHING', 'STAIN', 'TEAR', 'MACHINE', 'OTHER'] as const
export const scrapKey = (code: string): string => ((KNOWN_SCRAP as readonly string[]).includes(code) ? `scrap.${code}` : 'scrap.unknown')

export const KNOWN_UOM = ['PCS', 'PAIR', 'SET', 'M', 'CM', 'MM', 'M2', 'DM2', 'FT2', 'KG', 'G', 'L', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'] as const
export const uomKey = (uom: string | null): string => (uom && (KNOWN_UOM as readonly string[]).includes(uom) ? `uom.${uom}` : 'uom.unknown')

/** The rows of a view as CSV (the header in the person's language, days ISO). Never a price. */
export function jobsCsv(rows: readonly JobRow[], t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
  const cell = (value: string): string => (/[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const head = ['job', 'operations', 'style', 'workOrder', 'pieces', 'finished', 'kitDate', 'dueBack', 'state'].map((column) => cell(t(`csv.${column}`)))
  const body = rows.map((row) =>
    [row.number, operationsOf(row), `${row.workOrder.style.code} ${row.workOrder.style.name}`.trim(), row.workOrder.number, String(row.pieces), String(row.finished), row.kitDate ?? '', row.dueBack ?? '', t(`state.${row.state}`)].map(cell),
  )
  return [head, ...body].map((line) => line.join(';')).join('\n')
}

/** The jobs a bulk "Accept as asked" reaches: the selected ones that wait for an answer. */
export const acceptableOf = (rows: readonly JobRow[], selected: readonly string[]): JobRow[] => rows.filter((row) => selected.includes(row.id) && row.nextStep === 'ACCEPT')
