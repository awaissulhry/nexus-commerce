import { addDays, askProblems, DECLARATION_LIMITS, refuseProblem, cancelProblem, SHOWN_STATUSES, WAITING } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { DECLARATION_KINDS } from '@nexus/factory-domain/compliance/substances/rules'
import { isApiError } from '../../../../lib/api/errors'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import type { AskAnswer, AskBody, DeclarationDetail, DeclarationKind, DeclarationRequest, ShownStatus } from './api'

/**
 * Supplier declarations (B-W2b-267; design compliance.tests sec:ts-decl, the Supplier declaration record, pop:ts-request,
 * pop:ts-decl-review) without React: the address of the view (the API's own filters `shown`, `kind`, `q`; the record
 * `open` + `tab`; the Request declarations dialog `ask` with its prefill), the tiles as saved filters, every verb held in
 * words with its reason, the record's Activity composed from the request's own facts, the review of a Request declarations
 * per supplier, the decision's checks, and the CSV of a view. Pure.
 */

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'
type Words = (key: string, params?: Record<string, string | number>) => string

// ---- the address --------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['request', 'answer', 'decision', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export interface DeclarationsAddress {
  readonly shown: ShownStatus | null
  readonly kind: DeclarationKind | null
  readonly q: string
  /** The record open in its DetailModal (`?open=<id>`), its tab. */
  readonly open: string | null
  readonly tab: RecordTab
  /** Request declarations (`?ask=1`), prefilled with materials (`items=<id,id>`) and kinds (`kinds=RSL,PFAS`). */
  readonly ask: boolean
  readonly items: readonly string[]
  readonly kinds: readonly DeclarationKind[]
}

const list = (text: string | null | undefined): string[] => (text ?? '').split(',').map((part) => part.trim()).filter(Boolean)

export function declarationsAddressOf(params: { get(name: string): string | null } | null | undefined): DeclarationsAddress {
  const shown = params?.get('shown') ?? ''
  const kind = params?.get('kind') ?? ''
  const tab = params?.get('tab') ?? ''
  return {
    shown: (SHOWN_STATUSES as readonly string[]).includes(shown) ? (shown as ShownStatus) : null,
    kind: (DECLARATION_KINDS as readonly string[]).includes(kind) ? (kind as DeclarationKind) : null,
    q: params?.get('q') ?? '',
    open: params?.get('open') || null,
    tab: (RECORD_TABS as readonly string[]).includes(tab) ? (tab as RecordTab) : 'request',
    ask: params?.get('ask') === '1',
    items: list(params?.get('items')).slice(0, DECLARATION_LIMITS.materials),
    kinds: list(params?.get('kinds')).filter((value): value is DeclarationKind => (DECLARATION_KINDS as readonly string[]).includes(value)),
  }
}

/** The address text of the view (`?view=declarations&…`), the terms in a fixed order. */
export function declarationsAddressText(address: DeclarationsAddress): string {
  const search = new URLSearchParams()
  search.set('view', 'declarations')
  if (address.shown) search.set('shown', address.shown)
  if (address.kind) search.set('kind', address.kind)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.open) {
    search.set('open', address.open)
    if (address.tab !== 'request') search.set('tab', address.tab)
  }
  if (address.ask) {
    search.set('ask', '1')
    if (address.items.length > 0) search.set('items', address.items.join(','))
    if (address.kinds.length > 0) search.set('kinds', address.kinds.join(','))
  }
  return `?${search.toString()}`
}

export const withDeclarations = (address: DeclarationsAddress, change: Partial<DeclarationsAddress>): DeclarationsAddress => ({ ...address, ...change })

// ---- tiles and words ----------------------------------------------------------------------------------------------------

/** The status words' tone (a word with every colour, never colour alone). */
export const SHOWN_TONE: Readonly<Record<ShownStatus, Tone>> = {
  REQUESTED: 'info',
  OVERDUE: 'danger',
  ANSWERED: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
  REREQUEST_NEEDED: 'warning',
  CANCELLED: 'neutral',
}

/** "SVHC · list of 2026-07-01": the kind's short words key and the Candidate List day asked about. */
export const kindKey = (kind: DeclarationKind): string => `kind.${kind}`

/** A request's materials as one line ("DEMO-LEA-01 · Demo cowhide, +2"). */
export function materialsLine(request: Pick<DeclarationRequest, 'materials'>, more: (count: number) => string): string {
  const [first, ...rest] = request.materials
  if (!first) return '—'
  return rest.length === 0 ? first.articleLabel : `${first.articleLabel} ${more(rest.length)}`
}

/** Today's business day in the site's zone (YYYY-MM-DD). */
export const todayInRome = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/** The end of the due day, as an instant (the Countdown's target; the API's own overdue job runs on the site's day). */
export const dueInstant = (dueOn: string): string => `${dueOn}T22:59:59Z`

/** How the Due column speaks: waiting and not late (a countdown), late by N days, or just the day (decided, cancelled). */
export type DueWord = { readonly kind: 'countdown'; readonly to: string } | { readonly kind: 'late'; readonly days: number } | { readonly kind: 'day' }

export function dueWordOf(request: Pick<DeclarationRequest, 'status' | 'dueOn' | 'overdueDays'>): DueWord {
  if (!WAITING.has(request.status)) return { kind: 'day' }
  if (request.overdueDays > 0 || request.status === 'OVERDUE') return { kind: 'late', days: Math.max(1, request.overdueDays) }
  return { kind: 'countdown', to: dueInstant(request.dueOn) }
}

// ---- verbs and why they wait ---------------------------------------------------------------------------------------------

export interface DeclarationsCan {
  readonly view: boolean
  readonly manage: boolean
  readonly reviewDocuments: boolean
  readonly preview: boolean
  readonly filesUpload: boolean
}

export const DECLARATION_PERMISSIONS = {
  view: 'compliance.certificates.view',
  manage: 'compliance.supplierDeclarations.manage',
  reviewDocuments: 'purchasing.supplierDocuments.review',
  preview: 'partners.preview',
  filesUpload: 'files.upload',
} as const

export function declarationsCan(permissions: readonly string[]): DeclarationsCan {
  const held = new Set(permissions)
  return {
    view: held.has(DECLARATION_PERMISSIONS.view),
    manage: held.has(DECLARATION_PERMISSIONS.manage),
    reviewDocuments: held.has(DECLARATION_PERMISSIONS.reviewDocuments),
    preview: held.has(DECLARATION_PERMISSIONS.preview),
    filesUpload: held.has(DECLARATION_PERMISSIONS.filesUpload),
  }
}

/** A held verb: the words key and its values, or null when it may go. */
export interface Held {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const waiting = (request: Pick<DeclarationRequest, 'status'>): boolean => WAITING.has(request.status)

export function remindHeld(request: Pick<DeclarationRequest, 'status'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (!waiting(request)) return { key: 'held.remindNotWaiting' }
  return null
}

export function cancelHeld(request: Pick<DeclarationRequest, 'status'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (!waiting(request)) return { key: 'held.cancelNotWaiting' }
  return null
}

/** Accept: answered, every material answered, the supplier's document not refused (it is accepted first, with its own right). */
export function acceptHeld(request: Pick<DeclarationRequest, 'status' | 'lines' | 'answeredLines' | 'file' | 'channel'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (request.status !== 'ANSWERED') return { key: waiting(request) ? 'held.acceptNotAnswered' : 'held.decided' }
  if (request.answeredLines < request.lines) return { key: 'held.acceptLines', params: { count: request.lines - request.answeredLines } }
  if (request.file?.source === 'UPLOAD' && request.file.uploadStatus === 'REFUSED') return { key: 'held.uploadRefused' }
  if (request.file?.source === 'UPLOAD' && request.file.uploadStatus === 'WAITING' && !can.reviewDocuments) return { key: 'held.uploadReview' }
  return null
}

export function refuseHeld(request: Pick<DeclarationRequest, 'status'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (request.status !== 'ANSWERED') return { key: waiting(request) ? 'held.refuseNotAnswered' : 'held.decided' }
  return null
}

/** Ask again: a new request in place of this one (a waiting one is cancelled with it); an answered one is decided first. */
export function askAgainHeld(request: Pick<DeclarationRequest, 'status' | 'supersededBy'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (request.status === 'ANSWERED') return { key: 'held.askAgainAnswered' }
  if (request.supersededBy) return { key: 'held.askedAgain', params: { number: request.supersededBy.number } }
  return null
}

/** Record the answer in the office: a request asked by the office, still waiting (a portal request answers with the supplier's upload). */
export function answerHeld(request: Pick<DeclarationRequest, 'status' | 'channel'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (!waiting(request)) return { key: 'held.answerNotWaiting' }
  if (request.channel === 'OFFICE' && !can.filesUpload) return { key: 'held.filesUpload' }
  return null
}

/** Lines may be written while the request is open (waiting or answered, not decided). */
export function linesHeld(request: Pick<DeclarationRequest, 'status'>, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (request.status !== 'ANSWERED' && !waiting(request)) return { key: 'held.decided' }
  return null
}

/** See it as the supplier does: its portal's Documents page (partners.preview), only for a request asked in the portal. */
export function previewHeld(request: Pick<DeclarationRequest, 'channel'>, can: DeclarationsCan): Held | null {
  if (request.channel !== 'PORTAL') return { key: 'held.previewOffice' }
  if (!can.preview) return { key: 'held.preview' }
  return null
}

/** The portal address of the supplier's Documents page (portal.supplier.documents, SCR-190). */
export const portalDocumentsAddress = (partyCode: string): string => `/p/${encodeURIComponent(partyCode)}/documents`

/** Rows a bulk Remind reaches (waiting); the others say why their box is held. */
export const bulkRemindable = (request: Pick<DeclarationRequest, 'status'>): boolean => waiting(request)

// ---- the decision ------------------------------------------------------------------------------------------------------

export type CheckState = 'OK' | 'OPEN' | 'NOT_NEEDED'

export interface DecisionCheck {
  readonly id: string
  readonly state: CheckState
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** What must be true before Accept, each in words: answered, every material answered, the document, the list version. */
export function decisionChecks(detail: DeclarationDetail): DecisionCheck[] {
  const checks: DecisionCheck[] = []
  checks.push({ id: 'answered', state: detail.status === 'ANSWERED' || detail.status === 'ACCEPTED' || detail.status === 'REFUSED' ? 'OK' : 'OPEN', key: 'decision.check.answered' })
  const open = detail.lineRows.filter((line) => line.contains === null).length
  checks.push({ id: 'lines', state: open === 0 ? 'OK' : 'OPEN', key: open === 0 ? 'decision.check.linesOk' : 'decision.check.linesOpen', params: { count: open === 0 ? detail.lineRows.length : open, total: detail.lineRows.length } })
  if (detail.channel === 'PORTAL') {
    // The supplier's document: accepted already, or accepted first by Accept (a WAITING one); a REFUSED one stops it.
    const status = detail.upload?.status ?? null
    checks.push({ id: 'document', state: status === 'ACCEPTED' || status === 'WAITING' ? 'OK' : 'OPEN', key: status ? `decision.check.upload.${status === 'ACCEPTED' || status === 'WAITING' || status === 'REFUSED' ? status : 'OTHER'}` : 'decision.check.upload.NONE' })
  } else checks.push({ id: 'document', state: detail.file?.fileId ? 'OK' : 'OPEN', key: detail.file?.fileId ? 'decision.check.fileOk' : 'decision.check.fileNone' })
  if (detail.kind === 'REACH_SVHC') {
    const stated = detail.answeredListVersion ?? detail.svhcListVersion
    const newest = detail.newestListVersion
    const current = !newest || (stated !== null && stated.id === newest.id)
    checks.push({ id: 'list', state: current ? 'OK' : 'OPEN', key: current ? 'decision.check.listOk' : 'decision.check.listOld', params: { asked: stated?.publishedOn ?? '—', newest: newest?.publishedOn ?? '—' } })
  }
  return checks
}

/** A line's answer as a words key ("no", "yes, below the threshold", "yes, above", "not answered"). */
export function lineAnswerKey(line: { readonly contains: boolean | null; readonly aboveThreshold: boolean | null }): string {
  if (line.contains === null) return 'line.open'
  if (!line.contains) return 'line.none'
  return line.aboveThreshold ? 'line.above' : 'line.below'
}

export const LINE_TONE = (line: { readonly contains: boolean | null; readonly aboveThreshold: boolean | null }): Tone => (line.contains === null ? 'warning' : !line.contains ? 'success' : line.aboveThreshold ? 'danger' : 'info')

// ---- the record's Activity ---------------------------------------------------------------------------------------------

export interface ActivityStep {
  readonly id: string
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly at: string | null
  readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  readonly pending?: boolean
}

/**
 * The request's history from its own facts (the record has no thread of its own yet: B-W2b-267's gap): sent, each reminder
 * known (the count and the last one), the supplier's upload, answered, decided, cancelled, asked again; then what is still to
 * come (the answer by the due day, the decision). Oldest first.
 */
export function activityOf(detail: DeclarationDetail): ActivityStep[] {
  const steps: ActivityStep[] = []
  if (detail.supersedes) steps.push({ id: 'supersedes', key: 'activity.supersedes', params: { number: detail.supersedes.number }, at: detail.sentAt, tone: 'info' })
  steps.push({ id: 'sent', key: detail.channel === 'PORTAL' ? 'activity.sentPortal' : 'activity.sentOffice', params: { party: detail.party.name }, at: detail.sentAt, tone: 'info' })
  if (detail.remindersSent > 0) steps.push({ id: 'reminded', key: 'activity.reminded', params: { count: detail.remindersSent }, at: detail.lastRemindedAt, tone: 'neutral' })
  if (detail.status === 'OVERDUE' || (detail.overdueDays > 0 && WAITING.has(detail.status))) steps.push({ id: 'overdue', key: 'activity.overdue', params: { days: detail.overdueDays, due: detail.dueOn }, at: null, tone: 'danger' })
  if (detail.upload?.receivedAt) steps.push({ id: 'upload', key: 'activity.uploaded', params: { name: detail.upload.uploadedByName }, at: detail.upload.receivedAt, tone: 'info' })
  if (detail.answeredAt) steps.push({ id: 'answered', key: detail.channel === 'PORTAL' ? 'activity.answeredPortal' : 'activity.answeredOffice', at: detail.answeredAt, tone: 'info' })
  if (detail.decidedAt) steps.push({ id: 'decided', key: detail.status === 'REFUSED' ? 'activity.refused' : 'activity.accepted', params: { name: detail.decidedBy?.name ?? '—' }, at: detail.decidedAt, tone: detail.status === 'REFUSED' ? 'danger' : 'success' })
  if (detail.cancelledAt) steps.push({ id: 'cancelled', key: 'activity.cancelled', at: detail.cancelledAt, tone: 'neutral' })
  if (detail.supersededBy) steps.push({ id: 'askedAgain', key: 'activity.askedAgain', params: { number: detail.supersededBy.number }, at: null, tone: 'info' })
  if (WAITING.has(detail.status)) steps.push({ id: 'waitAnswer', key: 'activity.waitAnswer', params: { due: detail.dueOn }, at: null, tone: 'neutral', pending: true })
  if (detail.status === 'ANSWERED') steps.push({ id: 'waitDecision', key: 'activity.waitDecision', at: null, tone: 'neutral', pending: true })
  return steps
}

// ---- Request declarations ----------------------------------------------------------------------------------------------

export interface AskMaterialOption {
  readonly itemId: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly supplier: { readonly id: string; readonly code: string; readonly name: string } | null
  /** Kinds the profile misses (from the evaluator): the dialog's suggestion. */
  readonly missing: readonly DeclarationKind[]
}

export type AskStep = 'form' | 'review' | 'done'

export interface AskDraftState {
  readonly step: AskStep
  readonly itemIds: readonly string[]
  readonly kinds: readonly DeclarationKind[]
  readonly dueOn: string
  /** '' = never. */
  readonly reminderEveryDays: string
  readonly message: string
  readonly channel: 'AUTO' | 'PORTAL' | 'OFFICE'
}

export const DEFAULT_DUE_DAYS = 30
export const DEFAULT_REMINDER_DAYS = '7'

export function blankAsk(today: string, itemIds: readonly string[] = [], kinds: readonly DeclarationKind[] = []): AskDraftState {
  return { step: 'form', itemIds: [...itemIds], kinds: [...kinds], dueOn: addDays(today, DEFAULT_DUE_DAYS), reminderEveryDays: DEFAULT_REMINDER_DAYS, message: '', channel: 'AUTO' }
}

/** The kinds a set of materials misses (their profiles' `missing`), in the catalogue's order: the dialog's suggestion. */
export function suggestedKinds(options: readonly AskMaterialOption[], itemIds: readonly string[]): DeclarationKind[] {
  const wanted = new Set(options.filter((option) => itemIds.includes(option.itemId)).flatMap((option) => option.missing))
  return DECLARATION_KINDS.filter((kind) => wanted.has(kind))
}

/** The body the API is sent (the review and the send are the same body). */
export function askBodyOf(draft: AskDraftState): AskBody {
  const every = draft.reminderEveryDays.trim()
  return {
    materials: draft.itemIds.map((itemId) => ({ itemId })),
    kinds: [...draft.kinds],
    dueOn: draft.dueOn,
    reminderEveryDays: every === '' ? null : Number(every),
    message: draft.message.trim() || null,
    channel: draft.channel === 'AUTO' ? null : draft.channel,
  }
}

/** What holds the review, field by field (our words' keys); empty when it may go. */
export function askFieldProblems(draft: AskDraftState, today: string): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {}
  if (draft.itemIds.length === 0) problems.materials = 'ask.problem.materials'
  else if (draft.itemIds.length > DECLARATION_LIMITS.materials) problems.materials = 'ask.problem.tooMany'
  const every = draft.reminderEveryDays.trim()
  const reminder = every === '' ? null : Number(every)
  if (every !== '' && !/^\d+$/.test(every)) problems.reminderEveryDays = 'ask.problem.reminder'
  for (const issue of askProblems({ kinds: draft.kinds, dueOn: draft.dueOn, reminderEveryDays: Number.isNaN(reminder) ? -1 : reminder, message: draft.message.trim() || null, channel: draft.channel === 'AUTO' ? null : draft.channel }, today)) {
    const field = issue.path.split('/')[1] ?? ''
    if (field === 'kinds') problems.kinds = 'ask.problem.kinds'
    else if (field === 'dueOn') problems.dueOn = draft.dueOn < today ? 'ask.problem.duePast' : draft.dueOn > addDays(today, DECLARATION_LIMITS.dueDays) ? 'ask.problem.dueFar' : 'ask.problem.dueDay'
    else if (field === 'reminderEveryDays') problems.reminderEveryDays = 'ask.problem.reminder'
    else if (field === 'message') problems.message = 'ask.problem.message'
  }
  return problems
}

/** A review group's line in our words: what will happen, or why it will not (from the facts, not the API's English). */
export function groupWordsKey(group: AskAnswer['groups'][number], answer: Pick<AskAnswer, 'svhcListVersion'>): string {
  if (group.outcome === 'SEND') return group.channel === 'PORTAL' ? 'ask.group.sendPortal' : 'ask.group.sendOffice'
  if (group.outcome === 'ADD') return 'ask.group.add'
  if (group.request) return 'ask.group.skipAsked'
  if (group.kind === 'REACH_SVHC' && answer.svhcListVersion === null) return 'ask.group.skipNoList'
  if (group.channel === 'PORTAL' && !group.party.portalOn) return 'ask.group.skipPortalOff'
  return 'ask.group.skipOther'
}

export const GROUP_TONE: Readonly<Record<'SEND' | 'ADD' | 'SKIP', Tone>> = { SEND: 'success', ADD: 'info', SKIP: 'warning' }

/** "Send 6 requests" / "Add to 2 open requests": what the send button says. */
export function sendLabel(answer: AskAnswer | null): { key: string; params: Record<string, number> } {
  const send = answer?.counts.send ?? 0
  const add = answer?.counts.add ?? 0
  if (send > 0 && add > 0) return { key: 'ask.sendAndAdd', params: { send, add } }
  if (add > 0) return { key: 'ask.addOnly', params: { count: add } }
  return { key: 'ask.send', params: { count: send } }
}

/** Why the send waits after the review: nothing to send or add, offline, no right. */
export function sendHeld(answer: AskAnswer | null, can: DeclarationsCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (!answer) return { key: 'held.reviewFirst' }
  if (answer.counts.send + answer.counts.add === 0) return { key: 'held.nothingToAsk' }
  return null
}

// ---- refusals in our words ---------------------------------------------------------------------------------------------

/** A failed write in our words: the verb's own key per kind of failure (the API's English is never shown). */
export function writeProblemKey(verb: string, error: unknown): string {
  if (!isApiError(error)) return `problem.${verb}.failed`
  switch (error.kind) {
    case 'conflict':
      return `problem.${verb}.conflict`
    case 'forbidden':
    case 'step_up':
      return 'problem.forbidden'
    case 'invalid':
      return `problem.${verb}.invalid`
    case 'not_found':
      return 'problem.notFound'
    case 'unavailable':
      return 'problem.unavailable'
    default:
      return `problem.${verb}.failed`
  }
}

/** The reason typed for Reject (3 to 500, the supplier reads it) / Cancel (1 to 500): the words key of what is wrong, or null. */
export const refuseReasonProblem = (reason: string): string | null => (refuseProblem(reason) ? 'decision.reasonShort' : null)
export const cancelReasonProblem = (reason: string): string | null => (cancelProblem(reason) ? 'cancel.reasonShort' : null)

// ---- CSV ----------------------------------------------------------------------------------------------------------------

export function declarationsCsv(rows: readonly DeclarationRequest[], t: Words): string[][] {
  const header = ['csv.number', 'csv.supplier', 'csv.materials', 'csv.kind', 'csv.list', 'csv.requested', 'csv.due', 'csv.overdue', 'csv.reminders', 'csv.status', 'csv.validTo'].map((key) => t(key))
  return [
    header,
    ...rows.map((row) => [
      row.number,
      `${row.party.code} · ${row.party.name}`,
      row.materials.map((material) => material.articleLabel).join('; '),
      t(kindKey(row.kind)),
      row.svhcListVersion?.publishedOn ?? '',
      row.sentAt.slice(0, 10),
      row.dueOn,
      String(row.overdueDays),
      String(row.remindersSent),
      t(`shown.${row.shown}`),
      row.validTo ?? '',
    ]),
  ]
}
