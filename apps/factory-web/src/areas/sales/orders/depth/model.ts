import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Order, OrderStatus } from '../api'
import type { Phrase, Tone } from '../model'
import type {
  Approval,
  Change,
  Confirmation,
  CustomerDecision,
  ChangeYesState,
  DepositKinds,
  ExtraDepositKind,
  FinishSource,
  Freeze,
  FreezeField,
  FreezeStage,
  FreezeState,
  Materials,
  PricedBody,
  PrioritiesAnswer,
  PriorityLevel,
  PromiseLine,
  RiskState,
  TechPack,
  WaitReason,
} from './api'
import { EXTRA_DEPOSIT_KINDS, FREEZE_FIELDS, PRIORITY_LEVELS } from './api'

/**
 * B-W2b-323 — the orders in depth, pure (no fetching, no React; the tests hold them): who may do what, priority and season and
 * why a change is held, the yes an order waits for in words, what is frozen and the size cells locked with their reason, the
 * frozen refusals of an amendment and the offer of a priced change, the priced change's draft and body, the priced change
 * requests as rows, the customer's own materials, the confirmation's state, the brand tech pack in force, the production
 * finish forecast per line. Every word is a key of the `sales-orders-depth` catalogue (the API's English is never shown).
 */

export const NAMESPACE = 'sales-orders-depth'
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- rights -----------------------------------------------------------------------------------------------------------------

export interface DepthCan {
  view: boolean
  manage: boolean
  price: boolean
  /** Sales settings (seasons, freeze rules): finance and the owner. */
  settings: boolean
  /** The planner's reads (the milestones; the backlog). */
  planning: boolean
  /** Promises and the planned finish (sales holds it: planning.promise.view). */
  promise: boolean
  /** The inquiry an order came from, and its tech pack. */
  inquiries: boolean
  files: boolean
  /** Goods a customer sends (a receipt): the warehouse. */
  receive: boolean
  /** Run an import (and apply it). */
  importRun: boolean
  importApply: boolean
}

export function depthCanOf(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    view: held.has('orders.view'),
    manage: held.has('orders.manage'),
    price: held.has('money.price'),
    settings: held.has('sales.settings.manage'),
    planning: held.has('planning.view'),
    promise: held.has('planning.promise.view') || held.has('planning.view'),
    inquiries: held.has('sales.inquiries.view'),
    files: held.has('files.read'),
    receive: held.has('inventory.receive'),
    importRun: held.has('imports.run') && held.has('files.upload'),
    importApply: held.has('imports.apply'),
  }
}

const FINAL: readonly OrderStatus[] = ['CLOSED', 'CANCELLED']

// ---- priority ---------------------------------------------------------------------------------------------------------------

export const PRIORITY_TONE: Readonly<Record<PriorityLevel, Tone>> = Object.freeze({ LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'danger' })
export const URGENT_REASON_MAX = 500
/** Orders one "Set priority" changes at once (the API's limit). */
export const SELECTION_MAX = 200

/** Why priority (or the season) cannot change on this order now, or null. */
export function depthEditHeld(status: OrderStatus, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (FINAL.includes(status)) return phrase('held.final')
  return null
}

/** The urgent reason: one line of 1 to 500 characters, only for URGENT (another level carries none). */
export function urgentReasonProblem(level: PriorityLevel, reason: string): string | null {
  if (level !== 'URGENT') return null
  const text = reason.trim()
  if (text === '') return 'priority.problem.reason'
  if (text.length > URGENT_REASON_MAX) return 'priority.problem.long'
  if (/[\r\n]/.test(text)) return 'priority.problem.oneLine'
  return null
}

export const priorityBody = (level: PriorityLevel, reason: string): { priorityLevel: PriorityLevel; urgentReason: string | null } => ({ priorityLevel: level, urgentReason: level === 'URGENT' ? reason.trim() : null })

export const isPriorityLevel = (value: string): value is PriorityLevel => (PRIORITY_LEVELS as readonly string[]).includes(value)

/** "Set priority" on a selection: held with its reason before the click. */
export function selectionHeld(count: number, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (count === 0) return phrase('held.noneSelected')
  if (count > SELECTION_MAX) return phrase('held.tooMany', { max: SELECTION_MAX })
  return null
}

/** What one "Set priority" did, in words: changed, already so, left out (closed, cancelled or not yours), unknown. */
export function selectionOutcome(answer: PrioritiesAnswer): Phrase[] {
  const out: Phrase[] = []
  if (answer.changed.length > 0) out.push(phrase('selection.changed', { count: answer.changed.length }))
  if (answer.unchanged.length > 0) out.push(phrase('selection.unchanged', { count: answer.unchanged.length }))
  if (answer.skipped.length > 0) out.push(phrase('selection.skipped', { count: answer.skipped.length, numbers: answer.skipped.map((row) => row.number).join(', ') }))
  if (answer.unknown > 0) out.push(phrase('selection.unknown', { count: answer.unknown }))
  return out.length > 0 ? out : [phrase('selection.nothing')]
}

// ---- the yes an order waits for (SALES_ORDER) ----------------------------------------------------------------------------------

export const WAIT_TONE: Readonly<Record<WaitReason, Tone>> = Object.freeze({ REQUEST_PENDING: 'warning', NO_REQUEST: 'danger', CREDIT_HOLD: 'danger' })

/** Why the order waits, in words, the most pressing first (nobody asked; the customer's credit; a request open). */
export function waitPhrases(approval: Pick<Approval, 'reasons'>): Phrase[] {
  const order: WaitReason[] = ['NO_REQUEST', 'CREDIT_HOLD', 'REQUEST_PENDING']
  return order.filter((reason) => approval.reasons.some((entry) => entry.reason === reason)).map((reason) => phrase(`wait.${reason}`))
}

/** The open request (the newest PENDING), or null. */
export const openRequest = (approval: Pick<Approval, 'requests'>) => approval.requests.find((request) => request.status === 'PENDING') ?? null

export function askHeld(approval: Pick<Approval, 'may' | 'waiting'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!approval.waiting) return phrase('held.notWaiting')
  if (!approval.may.ask) return phrase('held.askStanding')
  return null
}

export function withdrawHeld(approval: Pick<Approval, 'may'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!approval.may.withdraw) return phrase('held.withdrawNotYours')
  return null
}

// ---- what is frozen ---------------------------------------------------------------------------------------------------------

export const FREEZE_TONE: Readonly<Record<FreezeState, Tone>> = Object.freeze({ OPEN: 'success', CHANGE_REQUEST: 'warning', BLOCKED: 'danger' })

/** A frozen size cell: the line, the size, the stage it reached and what a change needs. */
export interface FrozenCell {
  lineId: string
  seq: number
  size: string
  stage: FreezeStage | null
  state: FreezeState
}

/** The size cells locked by a rule (a company with no rule locks none). */
export function frozenCells(freeze: Freeze | null): FrozenCell[] {
  if (!freeze) return []
  return freeze.lines.flatMap((line) => line.sizes.filter((size) => size.locked && size.state !== 'OPEN').map((size) => ({ lineId: line.lineId, seq: line.seq, size: size.size, stage: size.stage, state: size.state })))
}

/** The frozen cells of one line, grouped by what they need and the stage reached ("Cutting started — size frozen: 48, 50"). */
export function frozenGroups(cells: readonly FrozenCell[], lineId: string): Array<{ stage: FreezeStage | null; state: FreezeState; sizes: string[] }> {
  const groups: Array<{ stage: FreezeStage | null; state: FreezeState; sizes: string[] }> = []
  for (const cell of cells.filter((entry) => entry.lineId === lineId)) {
    const group = groups.find((entry) => entry.stage === cell.stage && entry.state === cell.state)
    if (group) group.sizes.push(cell.size)
    else groups.push({ stage: cell.stage, state: cell.state, sizes: [cell.size] })
  }
  return groups
}

/** "What is frozen" (order.changes.freeze): each field at the order's furthest stage, in the fields' order. */
export function freezeRows(freeze: Freeze): Array<{ field: FreezeField; state: FreezeState; frozenFrom: FreezeStage | null }> {
  return FREEZE_FIELDS.map((field) => {
    const verdict = freeze.order.fields.find((entry) => entry.field === field)
    // A field read per line or per size: the strictest verdict any line reached.
    const lineVerdicts = freeze.lines.flatMap((line) => [...line.fields.filter((entry) => entry.field === field), ...(field === 'SIZE_QUANTITY' ? line.sizes.map((size) => ({ field, state: size.state, frozenFrom: size.stage })) : [])])
    const all = [...(verdict ? [verdict] : []), ...lineVerdicts]
    const strictest = all.reduce<{ state: FreezeState; frozenFrom: FreezeStage | null } | null>((worst, entry) => (!worst || STATE_RANK[entry.state] > STATE_RANK[worst.state] ? { state: entry.state, frozenFrom: entry.frozenFrom } : worst), null)
    return { field, state: strictest?.state ?? 'OPEN', frozenFrom: strictest?.frozenFrom ?? null }
  })
}
const STATE_RANK: Readonly<Record<FreezeState, number>> = Object.freeze({ OPEN: 0, CHANGE_REQUEST: 1, BLOCKED: 2 })

/** An amendment's refusals that are the freeze rules': `body/lines/<seq>/<FIELD>` and `body/<FIELD>`. */
export function frozenProblemsOf(problems: ReadonlyArray<{ path: string }>): Array<{ seq: number | null; field: FreezeField }> {
  const out: Array<{ seq: number | null; field: FreezeField }> = []
  for (const problem of problems) {
    const line = /^body\/lines\/(\d+)\/([A-Z_]+)$/.exec(problem.path)
    const order = /^body\/([A-Z_]+)$/.exec(problem.path)
    const field = (line?.[2] ?? order?.[1]) as FreezeField | undefined
    if (!field || !(FREEZE_FIELDS as readonly string[]).includes(field)) continue
    const seq = line ? Number(line[1]) : null
    if (!out.some((entry) => entry.seq === seq && entry.field === field)) out.push({ seq, field })
  }
  return out
}

/**
 * What a frozen amendment may still become: a priced change (some field asks a CHANGE_REQUEST), or nothing (every field it
 * touches is frozen for good: BLOCKED). The priced route checks again; this only says it before the click.
 */
export function frozenOffer(frozen: ReadonlyArray<{ seq: number | null; field: FreezeField }>, freeze: Freeze | null): 'priced' | 'blocked' | null {
  if (frozen.length === 0) return null
  if (!freeze) return 'priced'
  const blocked = frozen.every((entry) => {
    if (entry.seq === null) return freeze.order.fields.find((field) => field.field === entry.field)?.state === 'BLOCKED'
    const line = freeze.lines.find((row) => row.seq === entry.seq)
    if (!line) return false
    if (entry.field === 'SIZE_QUANTITY') return line.sizes.some((size) => size.locked) && line.sizes.filter((size) => size.locked).every((size) => size.state === 'BLOCKED')
    return line.fields.find((field) => field.field === entry.field)?.state === 'BLOCKED'
  })
  return blocked ? 'blocked' : 'priced'
}

// ---- the priced change (SAL-219) ------------------------------------------------------------------------------------------

export type DepositMode = 'default' | 'none' | 'pct' | 'amount'
export interface PricedDraft {
  /** Per line part: the office's words ("One more jacket in 52, cut on its own"); empty: the API's own. */
  labels: Record<string, string>
  fee: string
  deposit: DepositMode
  pct: string
  amount: string
  dueDate: string
  kind: ExtraDepositKind
  reason: string
}

export const PRICED_EMPTY: PricedDraft = Object.freeze({ labels: {}, fee: '', deposit: 'default', pct: '', amount: '', dueDate: '', kind: 'ACCONTO', reason: '' }) as PricedDraft
export const PRICED_LIMITS = Object.freeze({ label: 200, reason: 500 })

const DECIMAL = /^\d{1,12}([.,]\d{1,2})?$/
const PCT = /^\d{1,3}([.,]\d{1,4})?$/
const dot = (text: string) => text.trim().replace(',', '.')

/** The draft's problems by field (keys), before the preview is asked. */
export function pricedProblems(draft: PricedDraft, today: string, opts: { price: boolean; final?: boolean } = { price: true }): Partial<Record<'fee' | 'pct' | 'amount' | 'dueDate' | 'reason' | 'labels', string>> {
  const out: Partial<Record<'fee' | 'pct' | 'amount' | 'dueDate' | 'reason' | 'labels', string>> = {}
  if (opts.price && draft.fee.trim() !== '' && (!DECIMAL.test(draft.fee.trim()) || Number(dot(draft.fee)) <= 0)) out.fee = 'priced.problem.fee'
  if (opts.price && draft.deposit === 'pct' && (!PCT.test(draft.pct.trim()) || Number(dot(draft.pct)) <= 0 || Number(dot(draft.pct)) > 100)) out.pct = 'priced.problem.pct'
  if (opts.price && draft.deposit === 'amount' && (!DECIMAL.test(draft.amount.trim()) || Number(dot(draft.amount)) <= 0)) out.amount = 'priced.problem.amount'
  if (draft.deposit !== 'none' && draft.dueDate !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate) || draft.dueDate < today)) out.dueDate = 'priced.problem.dueDate'
  if (Object.values(draft.labels).some((text) => text.trim().length > PRICED_LIMITS.label || /[\r\n]/.test(text))) out.labels = 'priced.problem.label'
  if (opts.final) {
    const reason = draft.reason.trim()
    if (reason === '') out.reason = 'priced.problem.reason'
    else if (reason.length > PRICED_LIMITS.reason) out.reason = 'priced.problem.reasonLong'
  }
  return out
}

/** The priced change's body from the amendment's lines and header and the draft (money only with the price grain). */
export function pricedBodyOf(draft: PricedDraft, amendment: Pick<PricedBody, 'lines' | 'customerRef' | 'requestedDate'>, price: boolean): PricedBody {
  const labels = Object.fromEntries(Object.entries(draft.labels).filter(([, text]) => text.trim() !== '').map(([lineId, text]) => [lineId, text.trim()]))
  const body: PricedBody = { lines: amendment.lines, ...(amendment.customerRef !== undefined ? { customerRef: amendment.customerRef } : {}), ...(amendment.requestedDate !== undefined ? { requestedDate: amendment.requestedDate } : {}) }
  if (Object.keys(labels).length > 0) body.labels = labels
  if (price && draft.fee.trim() !== '') body.fee = dot(draft.fee)
  const due = draft.dueDate ? { dueDate: draft.dueDate } : {}
  if (draft.deposit === 'none') body.deposit = null
  else if (price && draft.deposit === 'pct') body.deposit = { pct: dot(draft.pct), kind: draft.kind, ...due }
  else if (price && draft.deposit === 'amount') body.deposit = { amount: dot(draft.amount), kind: draft.kind, ...due }
  else if (draft.kind !== 'ACCONTO' || draft.dueDate) body.deposit = { kind: draft.kind, ...due }
  return body
}

/** The deposit kinds offered: each with whether it may be chosen (the caparra penitenziale is off until the accountant's word). */
export function depositKindChoices(kinds: DepositKinds | null): Array<{ kind: ExtraDepositKind; available: boolean }> {
  return EXTRA_DEPOSIT_KINDS.map((kind) => ({ kind, available: kinds ? (kinds.kinds.find((entry) => entry.kind === kind)?.available ?? false) : kind !== 'CAPARRA_PENITENZIALE' }))
}

// ---- the changes (Changes tab) -------------------------------------------------------------------------------------------

export const YES_TONE: Readonly<Record<ChangeYesState, Tone>> = Object.freeze({ NOT_ASKED: 'neutral', WAITING: 'warning', APPROVED: 'success', TURNED_DOWN: 'danger', STALE: 'warning', WITHDRAWN: 'neutral' })
export const DECISION_TONE: Readonly<Record<CustomerDecision, Tone>> = Object.freeze({ NOT_NEEDED: 'neutral', NOT_ASKED: 'warning', WAITING: 'warning', ACCEPTED: 'success', REFUSED: 'danger', EXPIRED: 'danger', WITHDRAWN: 'neutral' })

/** The priced change requests, newest first. */
export const pricedChanges = (changes: readonly Change[]): Change[] => [...changes].filter((change) => change.priced).sort((a, b) => b.revision - a.revision)

/** What a change moved, in counts (lines changed, added, removed; pieces before → after). */
export function changeCounts(change: Pick<Change, 'diff'>): { changed: number; added: number; removed: number; before: number; after: number } {
  const counts = { changed: 0, added: 0, removed: 0, before: 0, after: 0 }
  for (const line of change.diff.lines) {
    if (line.change === 'CHANGED') counts.changed += 1
    if (line.change === 'ADDED') counts.added += 1
    if (line.change === 'REMOVED') counts.removed += 1
    counts.before += line.piecesBefore
    counts.after += line.piecesAfter
  }
  return counts
}

/** The sizes a change moved on one line ("52 +1 · 54 −2"). */
export function sizeMoves(line: Change['diff']['lines'][number]): Array<{ size: string; delta: number }> {
  return line.sizes.filter((size) => size.after !== size.before).map((size) => ({ size: size.size, delta: size.after - size.before }))
}

/** The put-back is offered for a change turned down (its yes) or refused (the customer). */
export const putBackOffered = (change: Pick<Change, 'yes' | 'customer' | 'putBack'>): boolean => change.putBack.may && (change.yes.state === 'TURNED_DOWN' || change.customer.decision === 'REFUSED' || change.customer.decision === 'EXPIRED')

export function putBackHeld(change: Pick<Change, 'putBack'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (!change.putBack.may) return phrase('held.putBackNot')
  return null
}

// ---- the customer's own materials (SAL-306) -------------------------------------------------------------------------------

/** A quantity as the API keeps it (4 decimals) in the person's language, without trailing zeros. */
export function quantityText(value: string, locale: string): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 4 }).format(number)
}

export interface MaterialRow {
  id: string
  item: string
  itemCode: string
  colour: string | null
  uom: string
  expected: string
  received: string
  used: string
  left: string
  /** More used than received (the customer must send more). */
  short: boolean
  lots: Array<{ id: string; code: string; receiptId: string | null; receiptNumber: string | null }>
}

/** The rows of the grid (Material · Colour · Expected · Received · Used · Left), each with the customer's lots of its material. */
export function materialRows(view: Materials): MaterialRow[] {
  return view.rows.map((row) => ({
    id: row.id,
    item: row.item.name,
    itemCode: row.item.code,
    colour: row.colour ? (row.colour.name ? `${row.colour.code} · ${row.colour.name}` : row.colour.code) : null,
    uom: row.uom,
    expected: row.expected,
    received: row.received,
    used: row.used,
    left: row.left,
    short: Number(row.used) > Number(row.received),
    lots: view.lots.filter((lot) => lot.itemId === row.item.id && (row.colour === null || lot.itemColourId === null || lot.itemColourId === row.colour.id)).map((lot) => ({ id: lot.id, code: lot.code, receiptId: lot.receiptId, receiptNumber: lot.receiptNumber })),
  }))
}

export function planHeld(can: Pick<DepthCan, 'manage'>, status: OrderStatus): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (FINAL.includes(status)) return phrase('held.final')
  return null
}

// ---- the order confirmation (SAL-208) -------------------------------------------------------------------------------------

export type ConfirmationState = 'none' | 'upToDate' | 'outdated' | 'notYet'

/** Where the confirmation stands: none made, the newest still prints the order, the order changed since, or not possible yet. */
export function confirmationState(confirmation: Pick<Confirmation, 'versions' | 'upToDate' | 'status'>): ConfirmationState {
  if (confirmation.status === 'PENDING_APPROVAL' || confirmation.status === 'CANCELLED') return confirmation.versions.length === 0 ? 'notYet' : confirmation.upToDate === false ? 'outdated' : 'upToDate'
  if (confirmation.versions.length === 0) return 'none'
  return confirmation.upToDate === false ? 'outdated' : 'upToDate'
}

/** Why Make / Send is held: no right, the order waits for a yes or was cancelled, busy. */
export function confirmationHeld(confirmation: Pick<Confirmation, 'status' | 'mayMake'>, can: Pick<DepthCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (confirmation.status === 'PENDING_APPROVAL') return phrase('held.confirmationWaiting')
  if (confirmation.status === 'CANCELLED') return phrase('held.confirmationCancelled')
  if (!confirmation.mayMake) return phrase('held.confirmationNot')
  return null
}

/** The row verb "Print confirmation" on the list: held while the order waits for a yes or was cancelled. */
export function printHeld(status: OrderStatus): Phrase | null {
  if (status === 'PENDING_APPROVAL') return phrase('held.confirmationWaiting')
  if (status === 'CANCELLED') return phrase('held.confirmationCancelled')
  return null
}

export const confirmationHref = (prefix: string, orderId: string): string => `${prefix}/sales/orders/${encodeURIComponent(orderId)}/confirmation`

/** The recipient of a confirmation: the quote's contact when it has an e-mail, else the customer's orders contact, else none. */
export function confirmationRecipient(contacts: ReadonlyArray<{ id: string; name: string; email: string | null; status: string; roles: readonly string[] }>, quoteContactId: string | null): { name: string; email: string } | null {
  const live = contacts.filter((contact) => contact.status === 'ACTIVE' && !!contact.email)
  const quote = quoteContactId ? live.find((contact) => contact.id === quoteContactId) : undefined
  const pick = quote ?? live.find((contact) => contact.roles.includes('ORDERS'))
  return pick && pick.email ? { name: pick.name, email: pick.email } : null
}

// ---- the brand tech pack in force -----------------------------------------------------------------------------------------

export type PackState = 'inForce' | 'newer' | 'gone'
export interface PackRow {
  id: string
  name: string
  size: number
  state: PackState
  named: number
  current: number | null
  /** The file to open: the version in force, else the one named. */
  openId: string
  available: boolean
}

export function packRows(pack: TechPack | null): PackRow[] {
  if (!pack?.inquiry) return []
  return pack.inquiry.techPack.files.map((file) => {
    const open = file.current ?? file.named
    return { id: file.named.id, name: file.named.originalName, size: file.named.sizeBytes, state: file.current === null ? 'gone' : file.newer ? 'newer' : 'inForce', named: file.named.versionNo, current: file.current?.versionNo ?? null, openId: open.id, available: open.status === 'AVAILABLE' }
  })
}

// ---- the production finish forecast (from the plan, B-W2b-317) --------------------------------------------------------------

export interface Forecast {
  finish: string | null
  source: FinishSource
  slackDays: number | null
  risk: RiskState | null
}

/** Each line of the order: its planned finish, what sets it, and days to spare (from the promise lines of every site read). */
export function forecastsOf(lines: readonly PromiseLine[], orderId: string): Map<string, Forecast> {
  const out = new Map<string, Forecast>()
  for (const line of lines) {
    if (line.order.id !== orderId) continue
    out.set(line.id, { finish: line.finish, source: line.finishSource, slackDays: line.slackDays, risk: line.risk })
  }
  return out
}

export const RISK_TONE: Readonly<Record<RiskState, Tone>> = Object.freeze({ LATE: 'danger', AT_RISK: 'warning', NOT_PROMISED: 'neutral', ON_TIME: 'success' })

/** The sites to read promises for: the order lines' own sites, and the person's sites for lines that name none. */
export function forecastSites(order: Pick<Order, 'lines'>, mine: ReadonlyArray<{ id: string }>): string[] {
  const own = order.lines.map((line) => line.siteId).filter((site): site is string => !!site)
  const any = order.lines.some((line) => !line.siteId)
  return [...new Set([...own, ...(any ? mine.map((site) => site.id) : [])])]
}

// ---- milestones (SO3:01) ----------------------------------------------------------------------------------------------------

export const MILESTONE_TONE: Readonly<Record<string, Tone>> = Object.freeze({ DONE: 'success', WAITING: 'warning', STARTED_BEFORE: 'info', TO_COME: 'neutral' })

// ---- problems in words ----------------------------------------------------------------------------------------------------

/** A failed read in this catalogue's words (never the API's). */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

/** A refused write in words; `reload` when the order moved under the person (read it again). */
export function writeProblemOf(error: unknown): Phrase & { reload: boolean } {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') {
    if (paths.some((path) => path.split(/[./]/).includes('version'))) return { key: 'problem.write.moved', reload: true }
    // The confirmation's PDF needs the company's letterhead (legal name, address, VAT number, codice fiscale, REA).
    if (paths.some((path) => path.startsWith('company/'))) return { key: 'problem.write.letterhead', reload: false }
    return { key: 'problem.write.state', reload: true }
  }
  if (error.kind === 'invalid') {
    if (paths.some((path) => path.includes('urgentReason'))) return { key: 'priority.problem.reason', reload: false }
    if (paths.some((path) => path.includes('seasonId'))) return { key: 'problem.write.season', reload: false }
    if (paths.some((path) => path.endsWith('/to') || path.includes('body/to'))) return { key: 'problem.write.noRecipient', reload: false }
    if (paths.some((path) => path.includes('deposit'))) return { key: 'priced.problem.deposit', reload: false }
    if (paths.some((path) => path.includes('fee'))) return { key: 'priced.problem.fee', reload: false }
    return { key: 'problem.write.invalid', reload: false }
  }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}
