import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { csvOf, dayAt, quantity } from '../../_shared/buying/model'
import type { ExceptionKind, ExceptionList, ExceptionQuery, PlanningException } from './api'

/**
 * Planning › Exceptions (SCR-125; design planning.exceptions, "an inbox you clear"), pure: the address (site, saved view,
 * type, search, the open detail), what each saved view asks the API (the tiles are three of them, so a tile's number and
 * its list agree), each exception said in our words from its kind and facts (never the API's English sentence), what a
 * person may do with it and why not, the fixes it points to (a purchase order, a work order, the board, the plan's line),
 * a refused write in words, and the CSV of the selected rows. No money, no figure per person.
 */

export const NAMESPACE = 'planning-exceptions'

export const VIEWS = ['queue', 'new', 'mine', 'snoozedToday', 'snoozed', 'resolved', 'all'] as const
export type ExceptionsView = (typeof VIEWS)[number]

export const viewOf = (value: string | null | undefined): ExceptionsView => ((VIEWS as readonly string[]).includes(value ?? '') ? (value as ExceptionsView) : 'queue')

export interface ExceptionsControls {
  site: string | null
  view: ExceptionsView
  kind: ExceptionKind | null
  q: string
  /** The exception whose detail is open (`?open=`). */
  open: string | null
}

export function controlsOf(params: { get(name: string): string | null } | null | undefined, kinds: readonly string[]): ExceptionsControls {
  const kind = params?.get('kind') ?? null
  return {
    site: params?.get('site') ?? null,
    view: viewOf(params?.get('view')),
    kind: kind && kinds.includes(kind) ? (kind as ExceptionKind) : null,
    q: params?.get('q') ?? '',
    open: params?.get('open') ?? null,
  }
}

export function queryOf(controls: ExceptionsControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.view !== 'queue') query.set('view', controls.view)
  if (controls.kind) query.set('kind', controls.kind)
  if (controls.q.trim()) query.set('q', controls.q.trim())
  if (controls.open) query.set('open', controls.open)
  return query.toString()
}

const OPEN = ['NEW', 'ACKNOWLEDGED'] as const

/** What a saved view asks the API (the API's own filters). "To clear" is the open queue without what is snoozed. */
export function apiQueryOf(view: ExceptionsView, kind: ExceptionKind | null): ExceptionQuery {
  const base = { kind }
  switch (view) {
    case 'queue':
      return { ...base, status: OPEN, snoozed: false }
    case 'new':
      return { ...base, status: ['NEW'] }
    case 'mine':
      return { ...base, status: OPEN, mine: true }
    case 'snoozedToday':
      return { ...base, status: OPEN, snoozed: true, limit: 200 }
    case 'snoozed':
      return { ...base, status: OPEN, snoozed: true }
    case 'resolved':
      return { ...base, status: ['RESOLVED'] }
    case 'all':
      return { ...base, status: ['NEW', 'ACKNOWLEDGED', 'RESOLVED'] }
  }
}

/**
 * The rows a view shows of what the API answered: "Snoozed until today" keeps the snoozes that end by the end of the
 * site's day (the tile's own count); a search over the material, its colour, the record and the numbers in the facts.
 */
export function visibleRows(rows: readonly PlanningException[], view: ExceptionsView, q: string, endOfToday: string): PlanningException[] {
  const needle = q.trim().toLowerCase()
  return rows.filter((row) => {
    if (view === 'snoozedToday' && !(row.snoozed && row.snoozedUntil !== null && row.snoozedUntil <= endOfToday)) return false
    if (!needle) return true
    const texts = [row.item?.code, row.item?.name, row.colour?.code, row.colour?.name, row.record?.label, ...Object.values(row.facts).filter((value): value is string => typeof value === 'string')]
    return texts.some((text) => !!text && text.toLowerCase().includes(needle))
  })
}

/** The tiles: saved views, counted by the API over the open queue (never the page shown). */
export const TILES: readonly { id: 'new' | 'mine' | 'snoozedToday'; view: ExceptionsView; count: (tiles: ExceptionList['tiles']) => number }[] = Object.freeze([
  { id: 'new', view: 'new', count: (tiles) => tiles.new },
  { id: 'mine', view: 'mine', count: (tiles) => tiles.mine },
  { id: 'snoozedToday', view: 'snoozedToday', count: (tiles) => tiles.snoozedUntilToday },
])

// ---- what a person may do --------------------------------------------------------------------------------------------

export interface ExceptionsCan {
  view: boolean
  manage: boolean
  run: boolean
}

export function exceptionsCan(permissions: readonly string[]): ExceptionsCan {
  const held = new Set(permissions)
  return { view: held.has('planning.view'), manage: held.has('planning.exceptions.manage'), run: held.has('planning.run') }
}

/** Why Acknowledge is held for this exception (a key of the catalogue), or null. */
export function ackHeld(row: PlanningException, can: Pick<ExceptionsCan, 'manage'>): string | null {
  if (!can.manage) return 'held.noManage'
  if (row.status === 'RESOLVED') return 'held.resolved'
  if (row.status === 'ACKNOWLEDGED') return 'held.acknowledged'
  return null
}

export function snoozeHeld(row: PlanningException, can: Pick<ExceptionsCan, 'manage'>): string | null {
  if (!can.manage) return 'held.noManage'
  if (row.status === 'RESOLVED') return 'held.resolved'
  return null
}

export function resolveHeld(row: PlanningException, can: Pick<ExceptionsCan, 'manage'>): string | null {
  if (!can.manage) return 'held.noManage'
  if (row.status === 'RESOLVED') return 'held.resolved'
  return null
}

/** A resolved row cannot be ticked (nothing is left to do with it); the others can. */
export const selectHeld = (row: PlanningException): string | null => (row.status === 'RESOLVED' ? 'held.resolvedRow' : null)

/** The ticked rows an "Acknowledge" reaches: the NEW ones. */
export const acknowledgeable = (rows: readonly PlanningException[]): PlanningException[] => rows.filter((row) => row.status === 'NEW')

/** A note to resolve with: 3 to 1000 characters (the API's RESOLVE_NOTE). */
export function noteProblem(note: string): string | null {
  const length = note.trim().length
  if (length < 3) return 'resolve.noteShort'
  if (length > 1000) return 'resolve.noteLong'
  return null
}

// ---- words ---------------------------------------------------------------------------------------------------------------

export interface Words {
  t: Translate
  /** The `buying` catalogue's units (`uom.FT2` …). */
  unit: (uom: string) => string
  locale: Locale
  timeZone?: string
}

const fact = (row: PlanningException, name: string): string | null => {
  const value = row.facts[name]
  return value === null || value === undefined ? null : String(value)
}
const dayText = (day: string | null, words: Words) => (day ? formatDate(dayAt(day), { locale: words.locale, timeZone: words.timeZone }) : '—')
const qty = (row: PlanningException, name: string, words: Words) => `${quantity(fact(row, name), words.locale)} ${words.unit(fact(row, 'uom') ?? '')}`.trim()
const minutes = (value: string | null, words: Words) => (value === null ? '—' : formatNumber(Number(value), words.locale, { maximumFractionDigits: 0 }))

/** The material in words ("DEMO-LEA-01 Nappa · Nero"), else the record's label, else the type. */
export function whatOf(row: PlanningException, words: Words): string {
  if (row.item) return `${row.item.code} ${row.item.name}${row.colour ? ` · ${row.colour.name}` : ''}`
  if (row.kind === 'LANE_OVERLOADED' || row.kind === 'LANE_UNDERUSED') return fact(row, 'laneCode') ?? row.record?.label ?? words.t(`kind.${row.kind}`)
  if (row.kind === 'PAST_DUE') return words.t('what.orderLine', { order: fact(row, 'orderNumber') ?? '—', seq: fact(row, 'lineSeq') ?? '—' })
  return row.record?.label ?? words.t(`kind.${row.kind}`)
}

/** The exception in one sentence, from its kind and facts (the design's "Leather A12 arrives 20 Nov; cutting needs it 14 Nov."). */
export function sentenceOf(row: PlanningException, words: Words): string {
  const { t } = words
  const material = row.item ? `${row.item.code}${row.colour ? ` ${row.colour.name}` : ''}` : whatOf(row, words)
  const days = row.daysLate ?? 0
  switch (row.kind) {
    case 'SHORT': {
      const who = row.ordersAffected > 1 ? t('words.orders', { count: row.ordersAffected }) : (fact(row, 'orderNumber') ?? t('words.orders', { count: 1 }))
      const base = t(fact(row, 'action') === 'MAKE' ? 's.SHORT.make' : 's.SHORT.buy', { material, quantity: qty(row, 'quantity', words), who, date: dayText(fact(row, 'needDate'), words) })
      return days > 0 ? `${base} ${t('s.SHORT.late', { count: days })}` : base
    }
    case 'SUPPLY_LATE':
      return fact(row, 'overdue') === 'true'
        ? t('s.SUPPLY_LATE.overdue', { material, po: fact(row, 'purchaseOrderNumber') ?? '—', date: dayText(fact(row, 'supplyDate'), words), quantity: qty(row, 'quantity', words) })
        : t('s.SUPPLY_LATE.late', { material, po: fact(row, 'purchaseOrderNumber') ?? '—', date: dayText(fact(row, 'supplyDate'), words), need: dayText(fact(row, 'needDate'), words), count: days })
    case 'PAST_DUE':
      return t('s.PAST_DUE', { order: fact(row, 'orderNumber') ?? '—', seq: fact(row, 'lineSeq') ?? '—', date: dayText(fact(row, 'dueDate'), words), count: days })
    case 'EXCESS':
      return fact(row, 'firm') === 'true'
        ? t('s.EXCESS.firm', { material, quantity: qty(row, 'quantity', words) })
        : t('s.EXCESS.po', { material, quantity: qty(row, 'quantity', words), po: fact(row, 'purchaseOrderNumber') ?? '—' })
    case 'CANCEL':
      return fact(row, 'firm') === 'true'
        ? t('s.CANCEL.firm', { material, quantity: qty(row, 'quantity', words) })
        : t('s.CANCEL.po', { material, quantity: qty(row, 'quantity', words), po: fact(row, 'purchaseOrderNumber') ?? '—' })
    case 'MOVE_EARLIER':
      return t('s.MOVE_EARLIER', { material, date: dayText(fact(row, 'supplyDate'), words), need: dayText(fact(row, 'needDate'), words), quantity: qty(row, 'quantity', words), count: days })
    case 'BELOW_SAFETY_STOCK':
      return t('s.BELOW_SAFETY_STOCK', { material, projected: qty(row, 'projected', words), date: dayText(fact(row, 'date'), words), safety: qty(row, 'safetyStock', words) })
    case 'NEGATIVE_STOCK':
      return t('s.NEGATIVE_STOCK', { material, quantity: qty(row, 'quantity', words) })
    case 'LANE_OVERLOADED':
      return t('s.LANE_OVERLOADED', { lane: fact(row, 'laneCode') ?? whatOf(row, words), from: dayText(fact(row, 'from'), words), to: dayText(fact(row, 'to'), words), pct: minutes(fact(row, 'loadPct'), words), booked: minutes(fact(row, 'bookedMinutes'), words), available: minutes(fact(row, 'availableMinutes'), words) })
    default:
      return t(`s.${row.kind}`, { what: whatOf(row, words) })
  }
}

/** The detail's title: who waits and how late ("SO-1043 will be 6 days late"), else what it is about. */
export function titleOf(row: PlanningException, words: Words): string {
  const { t } = words
  const days = row.daysLate ?? 0
  const order = fact(row, 'orderNumber')
  if (row.kind === 'SHORT' && days > 0 && order && row.ordersAffected <= 1) return t('title.late', { who: order, count: days })
  if (row.kind === 'SHORT' && days > 0) return t('title.lateOrders', { count: row.ordersAffected, days })
  if (row.kind === 'SUPPLY_LATE' && days > 0) return t('title.supplyLate', { po: fact(row, 'purchaseOrderNumber') ?? '—', count: days })
  if (row.kind === 'PAST_DUE') return t('title.pastDue', { what: whatOf(row, words), count: days })
  return t('title.of', { kind: t(`kind.${row.kind}`), what: whatOf(row, words) })
}

/** "2 orders · 6 days late", "—" when nothing waits on it. */
export function impactOf(row: PlanningException, words: Words): string {
  const parts: string[] = []
  if (row.ordersAffected > 0) parts.push(words.t('impact.orders', { count: row.ordersAffected }))
  if (row.daysLate !== null && row.daysLate > 0) parts.push(words.t('impact.late', { count: row.daysLate }))
  return parts.length > 0 ? parts.join(' · ') : '—'
}

export type StatusWord = 'NEW' | 'ACKNOWLEDGED' | 'SNOOZED' | 'SNOOZED_RUN' | 'RESOLVED' | 'CLEARED'

export function statusOf(row: PlanningException): StatusWord {
  if (row.status === 'RESOLVED') return row.resolution === 'CLEARED' ? 'CLEARED' : 'RESOLVED'
  if (row.snoozed) return row.snoozedUntil ? 'SNOOZED' : 'SNOOZED_RUN'
  return row.status
}

export function statusWords(row: PlanningException, words: Words): string {
  const status = statusOf(row)
  if (status === 'SNOOZED') return words.t('status.SNOOZED', { date: formatDate(row.snoozedUntil!, { locale: words.locale, timeZone: words.timeZone }) })
  return words.t(`status.${status}`)
}

export const statusTone = (row: PlanningException): 'info' | 'neutral' | 'success' | 'warning' => {
  const status = statusOf(row)
  return status === 'NEW' ? 'info' : status === 'RESOLVED' || status === 'CLEARED' ? 'success' : status === 'ACKNOWLEDGED' ? 'neutral' : 'warning'
}

export const kindTone = (kind: ExceptionKind): 'danger' | 'warning' | 'info' | 'neutral' =>
  kind === 'SHORT' || kind === 'NEGATIVE_STOCK' || kind === 'PAST_DUE' ? 'danger' : kind === 'SUPPLY_LATE' || kind === 'LANE_OVERLOADED' || kind === 'MOVE_EARLIER' || kind === 'BELOW_SAFETY_STOCK' ? 'warning' : kind === 'EXCESS' || kind === 'CANCEL' ? 'info' : 'neutral'

/** The owner in a list cell: "You", the office person's name, or nobody yet (routing is W3). */
export function ownerWords(row: PlanningException, words: Words): string {
  if (!row.owner) return words.t('owner.none')
  return row.mine ? words.t('owner.you') : row.owner.name
}

// ---- the fixes ---------------------------------------------------------------------------------------------------------------

export interface Fix {
  id: string
  /** A key of the catalogue and its values. */
  label: string
  params?: Record<string, string | number>
  href: string
}

/**
 * Where a fix is done (design tab:fix "the record a fix points to (PO, work order, board)": real links, so ⌘-click keeps
 * the queue open while fixing): chase the purchase order (its "Remind"), buy or move the firm order on the plan's line,
 * the work order, the board at the work order or the lane, Capacity & load, the material. Re-promise is W2b.
 */
export function fixesOf(row: PlanningException, place: { prefix: string; siteId: string | null }): Fix[] {
  const site = place.siteId ? `site=${encodeURIComponent(place.siteId)}&` : ''
  const fixes: Fix[] = []
  const record = row.record
  const plan = row.requirementId ? `${place.prefix}/planning/mrp?${site}view=all&line=${encodeURIComponent(row.requirementId)}` : null
  const po = record?.type === 'PurchaseOrder' ? record : null
  const workOrder = record?.type === 'WorkOrder' ? record : null
  const number = (name: string) => (typeof row.facts[name] === 'string' ? (row.facts[name] as string) : '')
  switch (row.kind) {
    case 'SHORT':
      if (plan) fixes.push({ id: 'buy', label: fact(row, 'action') === 'MAKE' ? 'fix.make' : 'fix.buy', href: plan })
      if (workOrder) {
        fixes.push({ id: 'board', label: 'fix.board', params: { number: workOrder.label ?? '' }, href: `${place.prefix}/planning/board?${site}wo=${encodeURIComponent(workOrder.id)}` })
        fixes.push({ id: 'wo', label: 'fix.workOrder', params: { number: workOrder.label ?? '' }, href: `${place.prefix}/production/work-orders/${encodeURIComponent(workOrder.id)}` })
      }
      break
    case 'SUPPLY_LATE':
      if (po) fixes.push({ id: 'chase', label: 'fix.chase', params: { number: po.label ?? number('purchaseOrderNumber') }, href: `${place.prefix}/purchasing/orders/${encodeURIComponent(po.id)}` })
      if (plan) fixes.push({ id: 'elsewhere', label: 'fix.elsewhere', href: plan })
      break
    case 'EXCESS':
    case 'CANCEL':
      if (po) fixes.push({ id: 'po', label: row.kind === 'CANCEL' ? 'fix.cancelLine' : 'fix.reduceLine', params: { number: po.label ?? number('purchaseOrderNumber') }, href: `${place.prefix}/purchasing/orders/${encodeURIComponent(po.id)}` })
      else if (plan) fixes.push({ id: 'firm', label: 'fix.firmLine', href: plan })
      break
    case 'MOVE_EARLIER':
      if (plan) fixes.push({ id: 'move', label: 'fix.moveFirm', href: plan })
      break
    case 'PAST_DUE':
      fixes.push({ id: 'order', label: 'fix.order', params: { number: number('orderNumber') }, href: `${place.prefix}/sales/orders?q=${encodeURIComponent(number('orderNumber'))}` })
      break
    case 'LANE_OVERLOADED': {
      const kind = number('laneKind') || (record?.type === 'Line' ? 'LINE' : 'WORK_CENTRE')
      const laneId = record?.id
      const from = number('from')
      if (laneId) fixes.push({ id: 'board', label: 'fix.boardLane', params: { lane: number('laneCode') }, href: `${place.prefix}/planning/board?${site}lane=${encodeURIComponent(`${kind}:${laneId}`)}${from ? `&from=${from}` : ''}` })
      fixes.push({ id: 'capacity', label: 'fix.capacity', href: `${place.prefix}/planning/capacity?${site}${from ? `from=${from}&` : ''}bucket=WEEK`.replace(/[?&]$/, '') })
      break
    }
    default:
      break
  }
  if (row.item && (row.kind === 'BELOW_SAFETY_STOCK' || row.kind === 'NEGATIVE_STOCK')) {
    if (plan) fixes.push({ id: 'line', label: 'fix.line', href: plan })
    fixes.push({ id: 'stock', label: 'fix.stock', params: { code: row.item.code }, href: `${place.prefix}/warehouse/stock?q=${encodeURIComponent(row.item.code)}` })
  }
  if (row.item) fixes.push({ id: 'material', label: 'fix.material', params: { code: row.item.code }, href: `${place.prefix}/products/materials/${encodeURIComponent(row.item.id)}` })
  return fixes
}

// ---- refusals ---------------------------------------------------------------------------------------------------------

/** A refused write in words (a key of the catalogue): changed meanwhile, already done, a bad note or time, no right, no answer. */
export function refusalOf(error: unknown): string {
  if (!isApiError(error)) return 'refusal.failed'
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') return /resolved/i.test(error.message) ? 'refusal.resolved' : /acknowledged/i.test(error.message) ? 'refusal.acknowledged' : 'refusal.changed'
  if (error.kind === 'invalid') return paths.some((path) => path.includes('until')) ? 'refusal.until' : paths.some((path) => path.includes('note')) ? 'refusal.note' : paths.some((path) => path.includes('exceptions')) ? 'refusal.sites' : 'refusal.invalid'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'refusal.forbidden'
  if (error.kind === 'not_found') return 'refusal.gone'
  if (error.kind === 'unavailable') return 'refusal.offline'
  return 'refusal.failed'
}

/** A failed read in words. */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'not_found') return 'error.gone'
  return 'error.failed'
}

// ---- export ----------------------------------------------------------------------------------------------------------------

export function csvOfRows(rows: readonly PlanningException[], words: Words): string {
  const { t } = words
  return csvOf(
    ['type', 'what', 'sentence', 'orders', 'daysLate', 'owner', 'ageDays', 'status', 'firstSeen', 'lastSeen'].map((column) => t(`csv.${column}`)),
    rows.map((row) => [t(`kind.${row.kind}`), whatOf(row, words), sentenceOf(row, words), row.ordersAffected, row.daysLate ?? '', ownerWords(row, words), row.ageDays, statusWords(row, words), row.firstSeenAt, row.lastSeenAt]),
  )
}

/** The previous and next exception of the queue around `id`; when `id` has left the queue, around the place it had. */
export function neighboursOf(order: readonly string[], id: string, seen: { id: string; at: number } | null): { prev: string | null; next: string | null } {
  const at = order.indexOf(id)
  if (at >= 0) return { prev: at > 0 ? order[at - 1]! : null, next: at < order.length - 1 ? order[at + 1]! : null }
  if (seen?.id !== id) return { prev: null, next: null }
  const place = Math.min(seen.at, order.length)
  return { prev: place > 0 ? order[place - 1]! : null, next: place < order.length ? order[place]! : null }
}
