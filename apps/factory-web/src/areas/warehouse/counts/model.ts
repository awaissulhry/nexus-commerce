import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { CountLine, CountQuery, CountRecord, CountRow, CountStatus, CountTiles } from './api'

/**
 * Warehouse › Counts (SCR-132) — the pure rules of the list, the count record and its dialogs: what this person may do
 * (permissions and the cost grain), the saved rows and the address, the next step of a count and why it is held (in our
 * words from the record's codes and figures, never the API's English), how a typed count is read, how a refused write is
 * said, and the CSV of the selection. The words live in `messages/<locale>/warehouse-counts.json`.
 */

export const COUNTS_NAMESPACES = ['warehouse-counts', 'stock', 'lists'] as const
export const TIME_ZONE = 'Europe/Rome'

// ---- abilities -------------------------------------------------------------------------------------------------------------

export interface CountsCan {
  view: boolean
  manage: boolean
  approve: boolean
  signOff: boolean
  /** Applying the differences posts COUNT moves: inventory.adjust. */
  apply: boolean
  /** The cost grain: the differences' value, unit costs, the valued list. */
  cost: boolean
  /** Choosing a material in New count / Found stock (Products › Materials & trims' list). */
  materials: boolean
  /** Choosing a lot or hide (Lots & traceability, Hides) and opening Movements. */
  stock: boolean
  locations: boolean
  /** The frozen valued list's files. */
  files: boolean
}

export function countsCan(permissions: readonly string[]): CountsCan {
  const held = new Set(permissions)
  return {
    view: held.has('inventory.counts.view'),
    manage: held.has('inventory.counts.manage'),
    approve: held.has('inventory.counts.approve'),
    signOff: held.has('inventory.counts.signoff'),
    apply: held.has('inventory.adjust'),
    cost: held.has('money.cost'),
    materials: held.has('product.materials.view'),
    stock: held.has('inventory.stock.view'),
    locations: held.has('inventory.locations.view'),
    files: held.has('files.read'),
  }
}

// ---- the list: saved rows, the address, the tiles ------------------------------------------------------------------------

export const LIST_VIEWS = ['open', 'drafts', 'counting', 'waiting', 'toApply', 'yearEnd', 'applied', 'signedOff', 'cancelled', 'all'] as const
export type ListView = (typeof LIST_VIEWS)[number]

export const isListView = (value: string | null | undefined): value is ListView => !!value && (LIST_VIEWS as readonly string[]).includes(value)
export const listViewOf = (value: string | null | undefined): ListView => (isListView(value) ? value : 'open')

/**
 * A saved row → the API's own filter, and the part the API cannot filter (approval needed or not) checked on the rows it
 * answers: "Waiting for approval" = submitted and over the limit; "To apply" = approved, or submitted under the limit.
 */
export function viewQuery(view: ListView): { query: CountQuery; keep: (row: CountRow) => boolean } {
  const all = () => true
  switch (view) {
    case 'open':
      return { query: { open: true }, keep: all }
    case 'drafts':
      return { query: { status: 'DRAFT' }, keep: all }
    case 'counting':
      return { query: { status: 'COUNTING' }, keep: all }
    case 'waiting':
      return { query: { status: 'SUBMITTED' }, keep: (row) => row.status === 'SUBMITTED' && row.approvalRequired === true }
    case 'toApply':
      return { query: { open: true }, keep: (row) => row.status === 'APPROVED' || (row.status === 'SUBMITTED' && row.approvalRequired === false) }
    case 'yearEnd':
      return { query: { kind: 'YEAR_END', open: true }, keep: all }
    case 'applied':
      return { query: { status: 'APPLIED' }, keep: all }
    case 'signedOff':
      return { query: { status: 'SIGNED_OFF' }, keep: all }
    case 'cancelled':
      return { query: { status: 'CANCELLED' }, keep: all }
    default:
      return { query: {}, keep: all }
  }
}

/** The tiles (design cn-metrics, each a saved row): counting, waiting for approval, to apply, the year-end inventory. */
export const TILES: ReadonlyArray<{ id: 'counting' | 'waiting' | 'toApply' | 'yearEnd'; view: ListView; count: (tiles: CountTiles) => number }> = [
  { id: 'counting', view: 'counting', count: (tiles) => tiles.counting },
  { id: 'waiting', view: 'waiting', count: (tiles) => tiles.waitingApproval },
  { id: 'toApply', view: 'toApply', count: (tiles) => tiles.toApply },
  { id: 'yearEnd', view: 'yearEnd', count: (tiles) => tiles.yearEnd },
]

export interface CountsAddress {
  view: ListView
  q: string
  siteId: string | null
  isNew: boolean
}

export function addressOf(params: { get(name: string): string | null } | null): CountsAddress {
  return {
    view: listViewOf(params?.get('view')),
    q: params?.get('q') ?? '',
    siteId: params?.get('site') || null,
    isNew: params?.get('new') === '1',
  }
}

export function addressText(address: CountsAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.siteId) query.set('site', address.siteId)
  if (address.isNew) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const STATUS_TONE: Readonly<Record<CountStatus, Tone>> = {
  DRAFT: 'neutral',
  COUNTING: 'info',
  SUBMITTED: 'warning',
  APPROVED: 'info',
  APPLIED: 'success',
  SIGNED_OFF: 'success',
  CANCELLED: 'neutral',
}

/** What a count counts, as message keys with values: the whole site, or the location (and under it), material, lot, kind. */
export function scopeParts(scope: CountRow['scope']): Array<{ key: string; params?: Record<string, string> }> {
  const parts: Array<{ key: string; params?: Record<string, string> }> = []
  if (scope.location) parts.push({ key: 'scope.location', params: { code: scope.location.code, name: scope.location.name } })
  if (scope.item) parts.push({ key: 'scope.item', params: { code: scope.item.code, name: scope.item.name } })
  if (scope.lot) parts.push({ key: 'scope.lot', params: { code: scope.lot.code } })
  if (scope.itemKind) parts.push({ key: `itemKind.${scope.itemKind}` })
  return parts.length > 0 ? parts : [{ key: 'scope.site' }]
}

export const COUNT_CSV_COLUMNS = ['number', 'kind', 'status', 'site', 'scope', 'inventoryDate', 'team', 'counted', 'lines', 'differing', 'value', 'currency', 'started', 'submitted', 'applied', 'signedOff'] as const

// ---- the record --------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['lines', 'differences', 'approval'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const recordTabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'lines')

/** The band's one primary step for this count now (or none). */
export type NextStep = 'start' | 'submit' | 'approve' | 'apply' | 'signOff' | null
export function nextStep(count: Pick<CountRecord, 'status' | 'kind' | 'approvalRequired'>): NextStep {
  switch (count.status) {
    case 'DRAFT':
      return 'start'
    case 'COUNTING':
      return 'submit'
    case 'SUBMITTED':
      return count.approvalRequired ? 'approve' : 'apply'
    case 'APPROVED':
      return 'apply'
    case 'APPLIED':
      return count.kind === 'YEAR_END' ? 'signOff' : null
    default:
      return null
  }
}

/** Words with their values (a key of `warehouse-counts`, or `stock:<key>`). */
export interface Phrase {
  key: string
  params?: Readonly<Record<string, string | number>>
}

/**
 * Why a step is held, in our words from the record's codes and figures (the API's `actions.<x>.reason` is English and
 * only decides THAT it is held). Null: the step may run.
 */
export function heldPhrase(record: CountRecord, step: Exclude<NextStep, null> | 'edit' | 'cancel' | 'sendBack' | 'record', can: CountsCan, inventoryDate?: string | null): Phrase | null {
  const action = record.actions[step]
  if (action.allowed) return null
  switch (step) {
    case 'start':
      if (record.status !== 'DRAFT') return { key: 'held.notDraft' }
      if (!can.manage) return { key: 'held.noManage' }
      return record.kind === 'YEAR_END' && inventoryDate ? { key: 'held.tooEarly', params: { date: inventoryDate } } : { key: 'held.notNow' }
    case 'submit': {
      if (record.status !== 'COUNTING') return { key: 'held.notCounting' }
      if (!can.manage) return { key: 'held.noManage' }
      const { uncounted, recountsDue, unreasoned } = record.summary
      if (uncounted > 0) return { key: 'held.uncounted', params: { count: uncounted } }
      if (recountsDue > 0) return { key: 'held.recountsDue', params: { count: recountsDue } }
      if (unreasoned > 0) return { key: 'held.unreasoned', params: { count: unreasoned } }
      return { key: 'held.notNow' }
    }
    case 'approve':
      if (record.approval.held === 'NOT_SUBMITTED') return { key: 'held.notSubmitted' }
      if (record.approval.held === 'NO_RIGHT') return { key: 'held.waitingApprover' }
      if (record.approval.held === 'OWN_VARIANCE') return { key: 'held.ownVariance' }
      return { key: 'held.notNow' }
    case 'apply':
      if (record.status === 'SUBMITTED' && record.approvalRequired) return { key: can.approve ? 'held.approveFirst' : 'held.waitingApprover' }
      if (record.status !== 'APPROVED' && record.status !== 'SUBMITTED') return { key: 'held.notApproved' }
      if (!can.apply) return { key: 'held.noAdjust' }
      return { key: 'held.notNow' }
    case 'signOff':
      if (record.kind !== 'YEAR_END') return { key: 'held.notYearEnd' }
      if (record.status === 'SIGNED_OFF') return { key: 'held.signedOff' }
      if (record.status !== 'APPLIED') return { key: 'held.notApplied' }
      if (!can.signOff) return { key: 'held.noSignOff' }
      if (!can.cost) return { key: 'held.noCostSignOff' }
      return { key: 'held.notNow' }
    case 'sendBack':
      if (record.status !== 'SUBMITTED') return { key: 'held.notSubmitted' }
      return { key: 'held.noApprove' }
    case 'record':
      if (record.status !== 'COUNTING') return { key: record.status === 'DRAFT' ? 'held.startFirst' : 'held.linesClosed' }
      return { key: 'held.noManage' }
    case 'edit':
      if (record.status !== 'DRAFT' && record.status !== 'COUNTING') return { key: 'held.notEditable' }
      return { key: 'held.noManage' }
    case 'cancel':
      if (!['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED'].includes(record.status)) return { key: record.status === 'CANCELLED' ? 'held.cancelled' : 'held.posted' }
      return { key: 'held.noManage' }
    default:
      return { key: 'held.notNow' }
  }
}

/** What the approval panel says about who decides (design: held "Waiting for approval by Warehouse manager"). */
export function approvalState(record: CountRecord): 'notNeeded' | 'notYet' | 'waiting' | 'approved' | 'withApply' | 'sentBack' {
  if (record.approvedAt) return record.approvalRequired === false ? 'withApply' : 'approved'
  if (record.status === 'SUBMITTED') return record.approvalRequired ? 'waiting' : 'notNeeded'
  if (record.rejectedAt && record.status === 'COUNTING') return 'sentBack'
  return 'notYet'
}

// ---- the lines -------------------------------------------------------------------------------------------------------------

/** Which number a line's cell types: the recount once one is asked for, else the count. */
export const typedField = (line: Pick<CountLine, 'recount'>): 'recount' | 'counted' => (line.recount ? 'recount' : 'counted')

/** The value the cell shows (what was typed, as the API wrote it). */
export const typedValue = (line: Pick<CountLine, 'recount' | 'counted'>): string | null => (line.recount ? line.recount.quantity : line.counted)

/** A quantity as the count field shows it: no thousands mark, trailing zeros dropped, the language's decimal mark. */
export function typedText(value: string | null, locale: 'it' | 'en'): string {
  if (value === null || value.trim() === '') return ''
  const [whole, fraction = ''] = value.trim().split('.')
  const kept = fraction.replace(/0+$/, '')
  return kept ? `${whole}${locale === 'it' ? ',' : '.'}${kept}` : whole!
}

/**
 * A typed count, read in either language's way ("12,5" or "12.5"; a thousands mark is refused, not guessed): the
 * decimal the API takes, '' for "take back", or the problem's key. At most 4 decimals, never below 0; a hide no more than
 * the area it measured.
 */
export function readCount(text: string, hideArea: string | null = null): { value: string | null; problem: string | null } {
  const raw = text.trim().replace(/\s+/g, '')
  if (raw === '') return { value: null, problem: null }
  if (!/^\d+([.,]\d+)?$/.test(raw)) return { value: null, problem: 'line.problem.number' }
  const [whole, fraction = ''] = raw.split(/[.,]/)
  if (fraction.length > 4) return { value: null, problem: 'line.problem.decimals' }
  const value = fraction ? `${whole}.${fraction}` : whole!
  if (hideArea !== null && Number(value) > Number(hideArea)) return { value: null, problem: 'line.problem.hideArea' }
  return { value, problem: null }
}

/** The same quantity? ("12.5000" and "12.5"). */
export const sameQuantity = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a === null || a === undefined || a === '' || b === null || b === undefined || b === '') return (a ?? '') === (b ?? '')
  return Number(a) === Number(b)
}

/** The line's state in our words: not counted yet, recount due, agrees, differs. */
export function lineState(line: Pick<CountLine, 'status' | 'difference'>): 'uncounted' | 'recountDue' | 'agrees' | 'differs' {
  if (line.status === 'UNCOUNTED') return 'uncounted'
  if (line.status === 'RECOUNT_DUE') return 'recountDue'
  return line.difference !== null && Number(line.difference) !== 0 ? 'differs' : 'agrees'
}

export const LINE_STATE_TONE: Readonly<Record<ReturnType<typeof lineState>, Tone>> = { uncounted: 'neutral', recountDue: 'warning', agrees: 'success', differs: 'danger' }

/**
 * A Differences row may be selected (to ask its recount, to give a reason) while the count is COUNTING and the person
 * may count; a line not counted yet is not recounted. Null: it may.
 */
export function differenceSelectable(line: Pick<CountLine, 'status'>, record: Pick<CountRecord, 'status'>, can: Pick<CountsCan, 'manage'>): string | null {
  if (record.status !== 'COUNTING') return 'diff.select.closed'
  if (!can.manage) return 'held.noManage'
  if (line.status === 'UNCOUNTED') return 'diff.select.uncounted'
  return null
}

/** The year-end inventory dates the New count offers: 31 Dec of last year and of this year (the nearer one first). */
export function yearEndChoices(now: Date): { years: number[]; preset: number } {
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, year: 'numeric' }).format(now))
  const month = Number(new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, month: 'numeric' }).format(now))
  return { years: [year - 1, year], preset: month >= 7 ? year : year - 1 }
}

/** A year-end inventory starts on its date or after it (Europe/Rome). */
export function startsLater(inventoryDate: string, now: Date): boolean {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return today < inventoryDate
}

// ---- refused writes ------------------------------------------------------------------------------------------------------

const KNOWN_PROBLEMS = new Set([
  'TOO_EARLY',
  'TOO_MANY_LINES',
  'HELD_BY_OTHER_COUNT',
  'UNCOUNTED',
  'RECOUNT_DUE',
  'NO_REASON',
  'OWN_VARIANCE',
  'ALREADY_COUNTED',
  'SNAPSHOT_LINE',
  'NOT_APPROVED',
  'NOT_EDITABLE',
  'NOT_COUNTING',
  'NOT_SUBMITTED',
  'NOT_DRAFT',
  'NOT_CANCELLABLE',
  'SIGNED_OFF',
  'NOT_APPLIED',
  'NOT_YEAR_END',
  'NOT_STARTED',
  'CANCELLED',
])

/** The numbers of other counts an English refusal names ("… counted by CNT-2026-0003"), shown as they are. */
const countNumbers = (message: string): string => (message.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g) ?? []).filter((text, index, all) => all.indexOf(text) === index).join(', ')

/**
 * A refused count write in our words: the count's own refusal codes (issues `problem/<CODE>`), a field the API named
 * (`body/phrase`, `body/inventoryDate`, `body/lines/<i>/counted`), else by kind (`stock:problem.*`).
 */
export function countProblem(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'stock:problem.write' }
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const code = path.startsWith('problem/') ? path.slice(8) : null
    if (code && KNOWN_PROBLEMS.has(code)) return { key: `problem.${code}`, params: { counts: countNumbers(issue.message ?? '') || '—' } }
    if (path === 'body/phrase') return { key: 'problem.phrase' }
    if (path === 'body/inventoryDate') return { key: 'problem.inventoryDate' }
    if (/^body\/lines\/\d+\/(counted|recount)$/.test(path) || path === 'body/counted') return { key: 'problem.quantity' }
    if (/^body\/lines\/\d+\/reasonCode$/.test(path) || path === 'body/reasonCode') return { key: 'problem.reason' }
    if (path === 'body/reason') return { key: 'problem.reasonText' }
  }
  switch (error.kind) {
    case 'conflict':
      // A newer version (the count's or a line's) is `conflict`; a state that does not allow it `invalid_state`.
      return error.code === 'invalid_state' ? { key: 'stock:problem.notNow' } : { key: 'stock:problem.changed' }
    case 'forbidden':
    case 'step_up':
      return { key: 'stock:problem.forbidden' }
    case 'not_found':
      return { key: 'stock:problem.gone' }
    case 'invalid':
      return { key: 'stock:problem.invalid' }
    case 'rate_limited':
      return { key: 'stock:problem.slowDown' }
    case 'unavailable':
      return { key: 'stock:problem.offline' }
    default:
      return { key: 'stock:problem.write' }
  }
}

/** A failed read in words (a key of `stock`): a failed read is never drawn as an empty list. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

/** Live: a count's own events and the stock moves its apply posts. */
export const COUNT_EVENTS = ['inventory.count_changed', 'inventory.count_recorded', 'inventory.count_applied', 'inventory.count_signed_off'] as const
export const isCountEvent = (type: string): boolean => (COUNT_EVENTS as readonly string[]).includes(type)
