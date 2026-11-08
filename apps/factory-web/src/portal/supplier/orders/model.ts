import { lineResponseOutcome, lineResponseSummary, lineResponseSummaryParts, lineDraftHasProblems, lineDraftProblems, type LineDraft, type LineRequest, type LineResponseCounts, type LineSummaryKey } from '@nexus/ui/patterns/LineResponseList/index'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { Locale } from '../../../lib/i18n/locales'
import { quantityTyped } from '../../../lib/po-answer/quantities'
import type { HistoryEntry, NoticeState, OrderChip, OrderLine, OrderPage, OrderRow, PortalConfirmBody, PortalDeclineReason, SupplierState } from './api'
import { DS_KIND, lineBodyOf, openLines, parseQuantityIn } from '../../../lib/po-answer/lines'

/**
 * SCR-189 — the supplier's Purchase orders (design portal.supplier.orders; B-W2b-179 on B-W2b-174's API), pure: the list's
 * chips and rows, the record's tabs, what the answer comes to and why Send waits, the answer the API takes, a stored
 * proposal read back into the line list, "Answers so far", a line's delivery state, the decline words, the CSV of a view.
 * No price, cost or amount anywhere (Owner answer C2). Words are keys of `portal-supplier-orders`; the views translate.
 */

export const NS = 'portal-supplier-orders'

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** The status pill's tone for a state the supplier reads. */
export function stateTone(state: SupplierState): Tone {
  switch (state) {
    case 'TO_CONFIRM':
      return 'warning'
    case 'CONFIRMED':
    case 'DELIVERED':
      return 'success'
    case 'CHANGE_PROPOSED':
    case 'BEING_CHANGED':
    case 'PARTLY_DELIVERED':
      return 'info'
    case 'DECLINED':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** The delivery column of a row: late, the next date expected, delivered, or nothing open. */
export function deliveryOf(row: Pick<OrderRow, 'state' | 'late' | 'nextExpected'>): { key: string; date: string | null; tone: Tone } {
  if (row.late) return { key: 'delivery.late', date: row.nextExpected, tone: 'danger' }
  if (row.state === 'DELIVERED' || row.state === 'CLOSED') return { key: 'delivery.done', date: null, tone: 'success' }
  if (row.state === 'CANCELLED' || row.state === 'DECLINED') return { key: 'delivery.none', date: null, tone: 'neutral' }
  if (row.nextExpected) return { key: 'delivery.next', date: row.nextExpected, tone: 'neutral' }
  return { key: 'delivery.notYet', date: null, tone: 'neutral' }
}

/** The list's address: `?chip=` (left out for the API's own default) and `?q=`. */
export function listQuery(chip: OrderChip | null, q: string): string {
  const search = new URLSearchParams()
  if (chip) search.set('chip', chip)
  if (q.trim()) search.set('q', q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The selected orders the bulk "Confirm as asked" can reach (only orders that wait for an answer). */
export const confirmableOf = (rows: readonly OrderRow[], selected: readonly string[]): OrderRow[] => rows.filter((row) => selected.includes(row.id) && row.canAnswer)

/** Why the bulk confirm waits (a key), or null. */
export function bulkConfirmHeld(reach: number, facts: { mayAnswer: boolean; preview: boolean; offline: boolean; busy: boolean }): string | null {
  if (facts.preview) return 'held.preview'
  if (facts.offline) return 'held.offline'
  if (!facts.mayAnswer) return 'held.mayAnswer'
  if (facts.busy) return 'held.busy'
  if (reach === 0) return 'held.noneToConfirm'
  return null
}

const CSV_COLUMNS = ['ourPo', 'yourRef', 'sentOn', 'version', 'lines', 'earliest', 'status', 'delivery'] as const

const csvCell = (value: string): string => (/[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** The rows of a view as CSV (the header in the person's language; days ISO, as a sheet reads them). Never a price. */
export function ordersCsv(rows: readonly OrderRow[], t: (key: string, params?: Readonly<Record<string, string | number>>) => string, locale: Locale): string {
  const head = CSV_COLUMNS.map((column) => csvCell(t(`col.${column}`)))
  const body = rows.map((row) => {
    const delivery = deliveryOf(row)
    return [row.number, row.supplierRef ?? '', row.sentAt ? row.sentAt.slice(0, 10) : '', String(row.revision), String(row.lines), row.earliestNeedDate ?? '', row.words[locale], t(delivery.key, { date: delivery.date ?? '' })].map(csvCell)
  })
  return [head, ...body].map((cells) => cells.join(',')).join('\r\n')
}

// ── the record ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const RECORD_TABS = ['lines', 'confirm', 'asn', 'documents', 'messages'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'lines')

/** The record's own address with a tab (and a line to show, from Home's next deliveries). */
export function recordHref(prefix: string, id: string, tab: RecordTab = 'lines', line?: string | null): string {
  const search = new URLSearchParams({ tab })
  if (line) search.set('line', line)
  return `${prefix}/orders/${encodeURIComponent(id)}?${search.toString()}`
}

/** A line's delivery state from what was received (its base unit) against its base quantity. */
export type LineDelivery = 'open' | 'partly' | 'delivered' | 'cancelled' | 'closedShort'
export function lineDeliveryOf(line: Pick<OrderLine, 'ended' | 'receivedBase' | 'baseQuantity'>): LineDelivery {
  if (line.ended === 'CANCELLED') return 'cancelled'
  if (line.ended === 'CLOSED_SHORT') return 'closedShort'
  const received = new Dec(line.receivedBase || '0')
  if (received.lte(0)) return 'open'
  if (line.baseQuantity !== null && received.gte(new Dec(line.baseQuantity))) return 'delivered'
  return 'partly'
}

/** "was …" beside a value a revision changed (quantity and need date only: the panel says the rest). */
export function wasOf(page: Pick<OrderPage, 'changes'>, lineId: string): { quantity: string | null; needDate: string | null; added: boolean } {
  const line = page.changes?.lines.find((entry) => entry.lineId === lineId)
  if (!line) return { quantity: null, needDate: null, added: false }
  const before = (field: string) => {
    const change = line.changes.find((entry) => entry.field === field)
    return typeof change?.before === 'string' ? change.before : null
  }
  // The revision keeps a quantity with its unit ("120.0000 FT2"): the number is shown in the line's own unit.
  const quantity = before('quantity')
  return { quantity: quantity ? (/^\d+(?:\.\d+)?/.exec(quantity.trim())?.[0] ?? null) : null, needDate: before('needDate'), added: line.kind === 'ADDED' }
}

/** The "What changed" panel opens by itself on the first visit after a revision: what this device remembers. */
export const seenKey = (orderId: string, revision: number): string => `fw-portal-po-seen:${orderId}:r${revision}`

/** The panel's items: the order's own changes first, then each line, with the API's sentence (the person's language). */
export function changeItems(changes: NonNullable<OrderPage['changes']>): { id: string; seq: number | null; kind: string | null; sentence: string }[] {
  const header = changes.header.length > 0 ? [{ id: 'order', seq: null, kind: null, sentence: changes.words.slice(0, changes.header.length).join(' · ') }] : []
  const lines = changes.lines.map((line, index) => ({ id: line.lineId, seq: line.seq, kind: line.kind, sentence: changes.words[changes.header.length + index] ?? '' }))
  return [...header, ...lines]
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type AnswerProblem = 'changed' | 'invalid' | 'forbidden' | 'missing' | 'rateLimited' | 'unavailable' | 'internal'

export interface AnswerDraft {
  /** The lines answered other than as asked. */
  readonly answers: Readonly<Record<string, LineDraft>>
  readonly supplierRef: string
  readonly note: string
}

export const MAX_REF = 60
export const MAX_NOTE = 1000

/** What the answer comes to, as the API decides it: a decline only when no line was confirmed before. */
export function outcomeOf(requests: readonly LineRequest[], answers: Readonly<Record<string, LineDraft>>): 'CONFIRMED' | 'PROPOSED' | 'DECLINED' {
  const outcome = lineResponseOutcome(requests, answers)
  if (outcome === 'DECLINED' && requests.some((line) => line.locked)) return 'PROPOSED'
  return outcome
}

/** The review line's parts (keys of the DS part's words) and the counts. */
export function reviewOf(requests: readonly LineRequest[], answers: Readonly<Record<string, LineDraft>>, locale: Locale): { counts: LineResponseCounts; parts: { key: LineSummaryKey; count: number }[] } {
  const counts = lineResponseSummary(requests, answers, { parseQuantity: parseQuantityIn(locale) })
  return { counts, parts: lineResponseSummaryParts(counts) }
}

export interface SendFacts {
  readonly canAnswer: boolean
  readonly mayAnswer: boolean
  readonly preview: boolean
  readonly offline: boolean
  readonly busy: boolean
}

/** Why "Send" waits (a key), or null when it may go. A line's answer is checked again with the part's own rules. */
export function sendHeld(requests: readonly LineRequest[], draft: AnswerDraft, facts: SendFacts, today: string, locale: Locale): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.canAnswer) return 'held.answered'
  if (!facts.mayAnswer) return 'held.mayAnswer'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  const rules = { today, parseQuantity: parseQuantityIn(locale) }
  for (const line of requests) {
    const answer = draft.answers[line.id]
    if (answer && !line.locked && lineDraftHasProblems(lineDraftProblems(line, answer, rules))) return 'held.incomplete'
  }
  if (draft.supplierRef.trim().length > MAX_REF) return 'held.ref'
  if (draft.note.trim().length > MAX_NOTE) return 'held.note'
  return null
}

const clean = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The confirm request for the answer as it stands: every line as asked is "confirm all as asked"; else line by line. */
export function confirmBodyOf(page: Pick<OrderPage, 'order' | 'lines'>, draft: AnswerDraft, locale: Locale): PortalConfirmBody {
  const open = openLines(page.lines)
  const changed = open.some((line) => draft.answers[line.id] && draft.answers[line.id]!.kind !== 'AS_ASKED')
  return {
    version: page.order.version,
    mode: changed ? 'BY_LINE' : 'ALL_AS_ASKED',
    ...(changed ? { lines: open.map((line) => lineBodyOf(line.id, draft.answers[line.id], locale)) } : {}),
    supplierRef: clean(draft.supplierRef),
    note: clean(draft.note),
  }
}

/** "Confirm all as asked" from Home or the list: the order's version, nothing else (the API confirms the open lines). */
export const confirmAllBody = (version: number, supplierRef = '', note = ''): PortalConfirmBody => ({ version, mode: 'ALL_AS_ASKED', supplierRef: clean(supplierRef), note: clean(note) })

/** A stored proposal of a line read back as the part's answer (what the supplier proposed, shown read-only). */
export function draftOfProposal(line: OrderLine, locale: Locale): LineDraft | null {
  const proposal = line.proposal
  if (!proposal || proposal.kind === 'AS_ASKED') return null
  const kind = DS_KIND[proposal.kind]
  const reason = proposal.reason ?? ''
  const typed = (value: string | null | undefined) => (value ? quantityTyped(value, locale) : '')
  switch (kind) {
    case 'CANNOT':
    case 'CHANGE':
      return { kind, reason }
    case 'SPLIT': {
      const [a, b] = proposal.deliveries
      return { kind, deliveries: [{ quantity: typed(a?.quantity), date: a?.date ?? '' }, { quantity: typed(b?.quantity), date: b?.date ?? '' }], reason }
    }
    case 'SUBSTITUTE':
      return { kind, quantity: typed(proposal.quantity), date: proposal.date ?? '', substituteId: proposal.substitute?.itemId ?? '', substitute: proposal.substitute?.note ?? '', reason }
    default:
      return { kind: 'OTHER', quantity: typed(proposal.quantity), date: proposal.date ?? '', reason }
  }
}

/** The proposals of an order as the part's answers (read-only list of what the supplier proposed). */
export function proposalAnswers(page: Pick<OrderPage, 'lines'>, locale: Locale): Record<string, LineDraft> {
  const out: Record<string, LineDraft> = {}
  for (const line of page.lines) {
    const draft = draftOfProposal(line, locale)
    if (draft) out[line.id] = draft
  }
  return out
}

/** A refused answer in this page's words. */
export function problemOf(kind: string | null | undefined): AnswerProblem {
  switch (kind) {
    case 'conflict':
      return 'changed'
    case 'invalid':
      return 'invalid'
    case 'forbidden':
      return 'forbidden'
    case 'not_found':
      return 'missing'
    case 'rate_limited':
      return 'rateLimited'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'internal'
  }
}

// ── the decline ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface DeclineDraft {
  readonly reason: PortalDeclineReason
  readonly note: string
  readonly tried: boolean
}

export function declineHeld(draft: DeclineDraft, facts: Omit<SendFacts, 'canAnswer'> & { canAnswer: boolean }): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.canAnswer) return 'held.answered'
  if (!facts.mayAnswer) return 'held.mayAnswer'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  if (draft.reason === 'OTHER' && draft.note.trim() === '') return 'decline.held.note'
  if (draft.note.trim().length > MAX_NOTE) return 'held.note'
  return null
}

/** The API keeps a decline as "<reason words>: <note>" in English: the reason said again in the page's words. */
const DECLINE_PREFIXES: readonly [PortalDeclineReason, string][] = [
  ['NO_CAPACITY', 'No capacity for this order'],
  ['MATERIAL_NOT_AVAILABLE', 'The material is not available'],
  ['PRICE', 'The price does not work for us'],
  ['OTHER', 'Another reason'],
]
export function declineReasonOf(text: string | null): { reason: PortalDeclineReason | null; note: string | null } {
  if (!text) return { reason: null, note: null }
  for (const [reason, words] of DECLINE_PREFIXES) {
    if (text === `${words}.`) return { reason, note: null }
    if (text.startsWith(`${words}: `)) return { reason, note: text.slice(words.length + 2) }
  }
  return { reason: null, note: text }
}

// ── "Answers so far" ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface HistoryStep {
  readonly key: string
  /** A key of the catalogue and its values. */
  readonly words: { readonly key: string; readonly params: Readonly<Record<string, string>> }
  readonly tone: Tone
  readonly at: string | null
  /** `reasonKey`: a key whose words fill `{reason}` (a decline's reason, said in the page's words). */
  readonly detail: { readonly key: string; readonly params: Readonly<Record<string, string>>; readonly reasonKey?: string } | null
}

/** Every version as sent, the answer it got and our decision on a proposal, oldest first. */
export function historySteps(history: readonly HistoryEntry[]): HistoryStep[] {
  const steps: HistoryStep[] = []
  for (const entry of history) {
    const version = String(entry.revision)
    steps.push({ key: `sent-${version}`, words: { key: 'history.sent', params: { version, number: entry.documentNumber } }, tone: 'neutral', at: entry.sentAt, detail: null })
    if (entry.confirmation) {
      steps.push({
        key: `confirmed-${version}`,
        words: { key: entry.confirmation.byName ? 'history.confirmedBy' : 'history.confirmed', params: { version, name: entry.confirmation.byName ?? '' } },
        tone: 'success',
        at: entry.confirmation.at,
        detail: entry.confirmation.supplierRef ? { key: 'history.yourRef', params: { ref: entry.confirmation.supplierRef } } : null,
      })
    }
    if (entry.proposal) {
      steps.push({
        key: `proposed-${version}`,
        words: { key: entry.proposal.byName ? 'history.proposedBy' : 'history.proposed', params: { version, name: entry.proposal.byName ?? '' } },
        tone: 'info',
        at: entry.proposal.at,
        detail: entry.proposal.note ? { key: 'history.note', params: { note: entry.proposal.note } } : null,
      })
      if (entry.proposal.decision === 'ACCEPTED' || entry.proposal.decision === 'REFUSED') {
        steps.push({ key: `decision-${version}`, words: { key: `history.decision.${entry.proposal.decision}`, params: { version } }, tone: entry.proposal.decision === 'ACCEPTED' ? 'success' : 'warning', at: null, detail: null })
      } else if (entry.answer === 'CHANGES_PROPOSED') {
        steps.push({ key: `waiting-${version}`, words: { key: 'history.decision.waiting', params: { version } }, tone: 'neutral', at: null, detail: null })
      }
    }
    if (entry.decline) {
      const { reason, note } = declineReasonOf(entry.decline.reason)
      steps.push({
        key: `declined-${version}`,
        words: { key: 'history.declined', params: { version } },
        tone: 'danger',
        at: entry.decline.at,
        detail: reason ? { key: note ? 'history.reasonNote' : 'history.reason', params: { note: note ?? '' }, reasonKey: `decline.reasons.${reason}` } : note ? { key: 'history.note', params: { note } } : null,
      })
    }
    if (!entry.confirmation && !entry.proposal && !entry.decline && entry.answer === 'WAITING') {
      steps.push({ key: `waiting-${version}`, words: { key: 'history.waiting', params: { version } }, tone: 'warning', at: null, detail: null })
    }
  }
  return steps
}

// ── ship notices ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function noticeTone(state: NoticeState): Tone {
  switch (state) {
    case 'RECEIVED':
      return 'success'
    case 'RECEIVED_WITH_DIFFERENCES':
      return 'warning'
    case 'ANNOUNCED':
    case 'IN_TRANSIT':
      return 'info'
    default:
      return 'neutral'
  }
}

/** Requests from us about one order (the task list's rows pointing at it), the confirmation request left out. */
export function requestsAbout<R extends { kind: string; href: string }>(rows: readonly R[], orderId: string): R[] {
  return rows.filter((row) => row.kind !== 'CONFIRM_PO' && row.href.includes(`/open/PurchaseOrder/${orderId}`))
}
