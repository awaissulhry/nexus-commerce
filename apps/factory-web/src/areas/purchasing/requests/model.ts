import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import type { SiteOption } from '../../_shared/buying/api'
import type { LiveState } from '../../_shared/buying/hooks'
import { phrase, quantity, type Loaded, type Phrase } from '../../_shared/buying/model'
import { KINDS, type BuyRequest, type ConvertBody, type ConvertPreview, type Converted, type DraftCard, type RequestCounts, type RequestDetail, type RequestKind, type RequestQuery, type SetAsideReason } from './api'

/**
 * Purchasing › Requests to buy (SCR-236; design purchasing.requests) — the screen's rules, pure: the saved views as the
 * API's own filters (the tiles are some of them), the address, why a row may not be picked, the groups (supplier, need
 * week), the source, the netting and the rounding in our words from the numbers (never the API's English), why "Draft
 * POs for n" and "Reject with reason" are held, the bodies the API takes, and where the source record opens. Every key is
 * of the `purchasing-requests` catalogue.
 */

export interface RequestsCan {
  /** purchasing.view: the queue itself. */
  view: boolean
  /** purchasing.manage: Draft POs. */
  manage: boolean
  /** planning.decide: Reject with reason (planning's set-aside of the plan lines). */
  decide: boolean
  /** The cost grain: prices and values (the columns are not drawn without it). */
  cost: boolean
  planView: boolean
  sites: boolean
}

export function requestsCan(permissions: readonly string[]): RequestsCan {
  const held = new Set(permissions)
  return {
    view: held.has('purchasing.view'),
    manage: held.has('purchasing.manage'),
    decide: held.has('planning.decide'),
    cost: held.has('money.cost'),
    planView: held.has('planning.view'),
    sites: held.has('inventory.locations.view'),
  }
}

// ---- views, filters, address -------------------------------------------------------------------------------------------

export const VIEWS = ['open', 'need14', 'held', 'converted', 'setAside', 'all'] as const
export type RequestsView = (typeof VIEWS)[number]
export const GROUPS = ['none', 'supplier', 'week'] as const
export type Group = (typeof GROUPS)[number]
/** The tile "Need date within 14 days" (factory-domain DUE_SOON_DAYS). */
export const SOON_DAYS = 14

export interface Filters {
  site: string | null
  kind: RequestKind | null
  q: string
  group: Group
}
export const NO_FILTERS: Filters = Object.freeze({ site: null, kind: null, q: '', group: 'none' }) as Filters

type Params = { get(name: string): string | null } | null

export const viewOf = (params: Params): RequestsView => {
  const view = params?.get('view') ?? ''
  return (VIEWS as readonly string[]).includes(view) ? (view as RequestsView) : 'open'
}

export function filtersOf(params: Params): Filters {
  const kind = params?.get('kind') ?? ''
  const group = params?.get('group') ?? ''
  return {
    site: params?.get('site') || null,
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as RequestKind) : null,
    q: params?.get('q') ?? '',
    group: (GROUPS as readonly string[]).includes(group) ? (group as Group) : 'none',
  }
}

export const openOf = (params: Params): string | null => params?.get('open') || null

/** The page's address with its view, filters and the open request (defaults left out). */
export function requestsAddress(base: string, view: RequestsView, filters: Filters, open: string | null = null): string {
  const query = new URLSearchParams()
  if (view !== 'open') query.set('view', view)
  if (filters.site) query.set('site', filters.site)
  if (filters.kind) query.set('kind', filters.kind)
  if (filters.q.trim()) query.set('q', filters.q.trim())
  if (filters.group !== 'none') query.set('group', filters.group)
  if (open) query.set('open', open)
  const qs = query.toString()
  return `${base}${qs ? `?${qs}` : ''}`
}

/** A calendar day plus whole days. */
export function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** A view as the API's own query (`today` in the site's zone, for "Need date within 14 days"). */
export function requestQuery(view: RequestsView, filters: Filters, today: string): RequestQuery {
  const base: RequestQuery = { siteId: filters.site, kind: filters.kind, q: filters.q }
  switch (view) {
    case 'open':
      return { ...base, status: 'OPEN' }
    case 'need14':
      return { ...base, status: 'OPEN', needBy: plusDays(today, SOON_DAYS) }
    case 'held':
      return { ...base, status: 'OPEN', held: true }
    case 'converted':
      return { ...base, status: 'CONVERTED' }
    case 'setAside':
      return { ...base, status: 'SET_ASIDE' }
    case 'all':
      return { ...base, status: 'ALL' }
  }
}

export interface Tile {
  id: 'open' | 'need14' | 'waiting' | 'converted'
  /** The view it is (null: no view yet — staff requests are W2b). */
  view: RequestsView | null
  count: (counts: RequestCounts) => number | null
}

/** "To handle": saved filters with the API's counts. */
export const TILES: readonly Tile[] = Object.freeze([
  { id: 'open', view: 'open', count: (counts: RequestCounts) => counts.open },
  { id: 'need14', view: 'need14', count: (counts: RequestCounts) => counts.needWithin14Days },
  { id: 'waiting', view: null, count: (counts: RequestCounts) => counts.waitingApproval },
  { id: 'converted', view: 'converted', count: (counts: RequestCounts) => counts.convertedToday },
] satisfies Tile[])

/** A tile's number: 0 when the answer is zero, '—' when unknown (not read yet, failed, or no such count yet). */
export const tileValue = (tile: Tile, counts: RequestCounts | null): string => {
  const value = counts ? tile.count(counts) : null
  return value === null ? '—' : String(value)
}

// ---- rows ------------------------------------------------------------------------------------------------------------------

/** Why a row may not be picked (its box disabled with these words), or null. */
export function selectableWhy(row: BuyRequest): Phrase | null {
  if (row.status !== 'OPEN') return phrase(`notOpen.${row.status}`, row.plan?.purchaseOrder ? { number: row.plan.purchaseOrder.number } : undefined)
  if (row.hold) return holdPhrase(row)
  return null
}

/** A hold in our words (the code; the supplier's or material's name where it helps). */
export function holdPhrase(row: Pick<BuyRequest, 'hold' | 'supplier' | 'item'>): Phrase | null {
  if (!row.hold) return null
  return phrase(`hold.${row.hold.code}`, { supplier: row.supplier?.name ?? '', material: row.item.code })
}

/** Where the need comes from: a firm planned order, work-order shortages, the plan run, a reorder point or a minimum. */
export function sourcePhrase(row: BuyRequest): Phrase {
  if (row.kind === 'REORDER') return phrase(row.reorder?.method === 'MIN_MAX' ? 'source.minMax' : 'source.reorderPoint')
  const plan = row.plan
  if (plan?.firm) return phrase('source.firm')
  if (plan && plan.workOrders.length > 0) return phrase('source.shortage', { count: plan.workOrders.length, numbers: plan.workOrders.slice(0, 2).join(', ') })
  return phrase('source.plan')
}

/** Who asked: the plan run (with its day, never a person) or the site's reorder rule. */
export function requestedByPhrase(row: BuyRequest): Phrase {
  return row.kind === 'PLAN' ? phrase('by.planRun') : phrase(row.reorder?.method === 'MIN_MAX' ? 'by.minMax' : 'by.reorderPoint', { site: row.site.code })
}

/** Where the suggested supplier came from (chosen, firm, the site's, the best approved source, the material's default). */
export const supplierFromPhrase = (row: Pick<BuyRequest, 'supplierFrom' | 'approvedSuppliers'>): Phrase | null =>
  row.supplierFrom ? phrase(`supplierFrom.${row.supplierFrom}`, { count: row.approvedSuppliers }) : null

/** The status in words: open (held with its reason), in a PO, set aside. */
export function statusPhrase(row: BuyRequest): Phrase {
  if (row.status === 'CONVERTED') return row.plan?.purchaseOrder ? phrase('status.inOrder', { number: row.plan.purchaseOrder.number }) : phrase('status.CONVERTED')
  if (row.status === 'SET_ASIDE') return row.plan?.setAside ? phrase('status.setAsideWhy', { reason: `reason.${row.plan.setAside.reason}` }) : phrase('status.SET_ASIDE')
  return row.hold ? phrase('status.held') : phrase('status.OPEN')
}

export const STATUS_TONE = { OPEN: 'info', CONVERTED: 'success', SET_ASIDE: 'neutral', HELD: 'warning' } as const
export const toneOf = (row: BuyRequest): (typeof STATUS_TONE)[keyof typeof STATUS_TONE] => (row.status === 'OPEN' && row.hold ? STATUS_TONE.HELD : STATUS_TONE[row.status])

/** The ISO week "2026-W46" as its number and year. */
export function weekParts(week: string): { week: number; year: number } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week)
  return match ? { year: Number(match[1]), week: Number(match[2]) } : null
}

/** The Monday of an ISO week (YYYY-MM-DD). */
export function weekMonday(week: string): string | null {
  const parts = weekParts(week)
  if (!parts) return null
  const jan4 = new Date(Date.UTC(parts.year, 0, 4))
  const day = jan4.getUTCDay() || 7
  const monday = new Date(jan4.getTime() - (day - 1) * 86_400_000 + (parts.week - 1) * 7 * 86_400_000)
  return monday.toISOString().slice(0, 10)
}

export const groupKey = (row: BuyRequest, group: Group): string => (group === 'supplier' ? (row.supplier?.id ?? '') : group === 'week' ? row.needWeek : '')

export function groupPhrase(row: BuyRequest, group: Group): Phrase | null {
  if (group === 'supplier') return row.supplier ? phrase('group.supplier', { name: row.supplier.name }) : phrase('group.noSupplier')
  if (group === 'week') {
    const parts = weekParts(row.needWeek)
    return parts ? phrase('group.week', parts) : phrase('group.noWeek')
  }
  return null
}

/**
 * The rows in their groups (the list frame draws no group rows: the rows are sorted by their group, the API's order kept
 * inside one, and the group's name and count are written on its first row). No group: the API's order.
 */
export function grouped(rows: readonly BuyRequest[], group: Group): { rows: BuyRequest[]; first: ReadonlyMap<string, number> } {
  if (group === 'none') return { rows: [...rows], first: new Map() }
  const order: string[] = []
  const byKey = new Map<string, BuyRequest[]>()
  for (const row of rows) {
    const key = groupKey(row, group)
    if (!byKey.has(key)) {
      byKey.set(key, [])
      order.push(key)
    }
    byKey.get(key)!.push(row)
  }
  // Supplier groups by name (no supplier last); week groups by the week (soonest first).
  const name = (key: string) => byKey.get(key)![0]!.supplier?.name ?? '￿'
  order.sort((a, b) => (group === 'week' ? a.localeCompare(b) : name(a).localeCompare(name(b))))
  const out: BuyRequest[] = []
  const first = new Map<string, number>()
  for (const key of order) {
    const members = byKey.get(key)!
    first.set(members[0]!.id, members.length)
    out.push(...members)
  }
  return { rows: out, first }
}

// ---- words from the numbers ------------------------------------------------------------------------------------------------

/** The rounding steps in words ("at least 50 ft² (the supplier's minimum)"), from the rule codes. */
export function roundingPhrases(row: Pick<BuyRequest, 'rounding' | 'uom'>, locale: Locale): Phrase[] {
  return row.rounding.map((step) => phrase(`rounding.${/^[A-Z_]+$/.test(step.rule) ? step.rule : 'OTHER'}`, { quantity: quantity(step.quantity, locale, 4), uom: `uom.${row.uom}` }))
}

/** The netting of a plan row (need − usable − on order = short, then what to buy), or a reorder row's position, in words. */
export function nettingPhrases(row: BuyRequest, locale: Locale): Phrase[] {
  const q = (text: string) => quantity(text, locale, 4)
  const base = `uom.${row.baseUom}`
  const out: Phrase[] = []
  if (row.plan) {
    const plan = row.plan
    out.push(phrase('net.need', { quantity: q(plan.grossQuantity), uom: base }))
    out.push(phrase('net.usable', { quantity: q(plan.usableStock), uom: base }))
    if (Number(plan.heldStock) > 0) out.push(phrase('net.held', { quantity: q(plan.heldStock), uom: base }))
    out.push(phrase('net.onOrder', { quantity: q(plan.onOrder), uom: base }))
    out.push(phrase('net.short', { quantity: q(plan.netQuantity), uom: base }))
  } else if (row.reorder) {
    const rule = row.reorder
    out.push(phrase('net.position', { position: q(rule.position), usable: q(rule.usable), onOrder: q(rule.onOrder), reserved: q(rule.reserved), uom: base }))
    out.push(phrase(rule.method === 'MIN_MAX' ? 'net.belowMinimum' : 'net.atPoint', { level: q(rule.level), uom: base }))
    out.push(phrase('net.ruleOrders', { quantity: q(rule.quantity), uom: base }))
  }
  out.push(phrase(`net.buy.${row.quantityFrom}`, { quantity: q(row.quantity), uom: `uom.${row.uom}` }))
  return out
}

/** The request's history: the run that found it (or the live reorder rule), then its decision. */
export function historyPhrases(row: BuyRequest): { at: string | null; words: Phrase }[] {
  const out: { at: string | null; words: Phrase }[] = []
  if (row.plan) {
    out.push({ at: row.plan.runStartedAt, words: phrase('history.run') })
    if (row.plan.setAside) out.push({ at: row.plan.decidedAt, words: phrase('history.setAside', { reason: `reason.${row.plan.setAside.reason}` }) })
    else if (row.plan.purchaseOrder) out.push({ at: row.plan.decidedAt, words: phrase('history.ordered', { number: row.plan.purchaseOrder.number }) })
  } else {
    out.push({ at: null, words: phrase('history.reorderLive') })
  }
  return out
}

// ---- held ------------------------------------------------------------------------------------------------------------------

/** Why "Draft POs for n" is held for these rows, or null. */
export function draftHeld(rows: readonly BuyRequest[], can: Pick<RequestsCan, 'manage'>, offline: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (offline) return phrase('held.offline')
  if (rows.length === 0) return phrase('held.selectFirst')
  const open = rows.filter((row) => selectableWhy(row) === null)
  if (open.length === 0) return phrase('held.noneOpen')
  return null
}

/** Why "Reject with reason" is held: no planning.decide, a reorder row in the pick (no table: change the rule), nothing open. */
export function rejectHeld(rows: readonly BuyRequest[], can: Pick<RequestsCan, 'decide'>, offline: boolean): Phrase | null {
  if (!can.decide) return phrase('held.noDecide')
  if (offline) return phrase('held.offline')
  if (rows.length === 0) return phrase('held.selectFirst')
  if (rows.some((row) => row.kind === 'REORDER')) return phrase('held.reorderNoReject')
  if (!rows.some((row) => row.status === 'OPEN')) return phrase('held.noneOpen')
  return null
}

// ---- bodies ----------------------------------------------------------------------------------------------------------------

/** The requests a dialog drafts: the open ones, each with the version read and the supplier the buyer picked. */
export function convertRequestsOf(rows: readonly BuyRequest[], suppliers: Readonly<Record<string, string>> = {}): ConvertBody['requests'] {
  return rows
    .filter((row) => row.status === 'OPEN')
    // The API names the row behind each request (the plan line's or the reorder rule's id), not the request's own id.
    .map((row) => ({ kind: row.kind, id: row.refId, version: row.version, ...(suppliers[row.id] ? { supplierId: suppliers[row.id] } : {}) }))
}

/** A card's key (one per supplier and delivery site). */
export const cardKey = (card: Pick<DraftCard, 'supplier' | 'siteId'>): string => `${card.supplier.id}|${card.siteId}`

/** The open draft a card may add to (the one it adds to, or the supplier's open draft beside a new one). */
export const existingDraftOf = (card: DraftCard) => card.draft ?? card.openDraft

/** Where a card's lines go: 'existing' (its draft) or 'new', as the buyer picked, else the preview's own choice. */
export function intoOf(card: DraftCard, picked: Readonly<Record<string, 'existing' | 'new'>>): 'existing' | 'new' {
  const choice = picked[cardKey(card)]
  if (choice === 'existing' && existingDraftOf(card)) return 'existing'
  if (choice === 'new') return 'new'
  return card.into === 'EXISTING' ? 'existing' : 'new'
}

/** The conversion's `into`: per card, its open draft or a new one (null). */
export function intoBody(cards: readonly DraftCard[], picked: Readonly<Record<string, 'existing' | 'new'>>): NonNullable<ConvertBody['into']> {
  return cards.map((card) => ({ supplierId: card.supplier.id, siteId: card.siteId, purchaseOrderId: intoOf(card, picked) === 'existing' ? existingDraftOf(card)!.id : null }))
}

/** Why Confirm is held in the Draft POs dialog: held requests (the whole batch is refused), a card without the right. */
export function confirmHeld(draft: Pick<DraftModel, 'preview' | 'busy'>, offline: boolean): Phrase | null {
  if (draft.busy) return phrase('held.busy')
  if (offline) return phrase('held.offline')
  if (draft.preview.status !== 'ready') return phrase('held.loading')
  const preview = draft.preview.value
  if (preview.held.length > 0) return phrase('draft.heldFirst', { count: preview.held.length })
  if (preview.cards.length === 0) return phrase('held.noneOpen')
  const noRight = preview.cards.find((card) => !card.mayDraft)
  if (noRight) return phrase('draft.noRight', { supplier: noRight.supplier.name, site: noRight.site.code })
  return null
}

/** Why the reject dialog's Confirm is held. */
export function rejectConfirmHeld(reject: Pick<RejectModel, 'reason' | 'note' | 'busy' | 'requestIds'>): Phrase | null {
  if (reject.busy) return phrase('held.busy')
  if (!reject.reason) return phrase('reject.pickReason')
  if (reject.reason === 'OTHER' && reject.note.trim() === '') return phrase('reject.noteNeeded')
  if (reject.requestIds.length === 0) return phrase('held.noneOpen')
  return null
}

/** The set-aside's lines: the plan lines behind the open plan rows. */
export const rejectLinesOf = (rows: readonly BuyRequest[]) => rows.filter((row) => row.kind === 'PLAN' && row.status === 'OPEN').map((row) => ({ id: row.refId, version: row.version }))

/** A refused conversion in our words: a supplier not approved, a held request, changed meanwhile, else by kind. */
export function convertRefusal(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  // Issue paths come as `body/requests/0/supplierId` (or dotted when the API sends a list).
  const paths = error.issues.map(issuePath).map((path) => path.replace(/\./g, '/'))
  if (paths.some((path) => path.endsWith('/supplierId') || path.includes('NOT_APPROVED'))) return phrase('refused.notApproved')
  if (error.kind === 'conflict') return phrase('refused.changed')
  switch (error.kind) {
    case 'forbidden':
    case 'step_up':
      return phrase('problem.forbidden')
    case 'invalid':
      return phrase('refused.invalid')
    case 'unavailable':
      return phrase('problem.offline')
    case 'not_found':
      return phrase('problem.gone')
    default:
      return phrase('problem.write')
  }
}

// ---- where things open -----------------------------------------------------------------------------------------------------

/** The source record of a request, for a new tab: the plan line's Why on What to buy & make, else the material. */
export function sourceHref(prefix: string, row: Pick<BuyRequest, 'kind' | 'siteId' | 'refId' | 'item'>): string {
  if (row.kind === 'PLAN') return `${prefix}/planning/mrp?site=${encodeURIComponent(row.siteId)}&line=${encodeURIComponent(row.refId)}`
  return `${prefix}/products/materials/${encodeURIComponent(row.item.id)}`
}
export const workOrderHref = (prefix: string, number: string) => `${prefix}/production/work-orders?q=${encodeURIComponent(number)}`
export const salesOrderHref = (prefix: string, id: string) => `${prefix}/sales/orders/${encodeURIComponent(id)}`
export const orderHref = (prefix: string, id: string) => `${prefix}/purchasing/orders/${encodeURIComponent(id)}`

// ---- the page models -------------------------------------------------------------------------------------------------------

export interface DetailModel {
  requestId: string
  detail: Loaded<RequestDetail>
  /** The supplier the buyer picked from the approved sources (null: the suggested one). */
  supplierId: string | null
}

export interface DraftModel {
  /** The requests asked for (the held ones may be left out). */
  requestIds: string[]
  /** The suppliers picked in the detail, per request id. */
  suppliers: Record<string, string>
  preview: Loaded<ConvertPreview>
  /** Per card (cardKey): its open draft or a new one, as the buyer picked. */
  into: Record<string, 'existing' | 'new'>
  busy: boolean
  problem: Phrase | null
  result: Converted | null
}

export interface RejectModel {
  requestIds: string[]
  reason: SetAsideReason | ''
  note: string
  busy: boolean
  problem: Phrase | null
}

export interface RequestsModel {
  prefix: string
  can: RequestsCan
  view: RequestsView
  filters: Filters
  rows: { items: BuyRequest[] | null; more: boolean; matching: number | null; problem: string | null }
  counts: { value: RequestCounts | null; problem: string | null }
  sites: SiteOption[]
  asOf: string | null
  live: LiveState
  offline: boolean
  updates: number
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase; orders?: { id: string; number: string }[] } | null
  detail: DetailModel | null
  draft: DraftModel | null
  reject: RejectModel | null
  timeZone?: string
  /** Design cases. */
  selected?: readonly string[]
  helpOpen?: boolean
  keysOpen?: boolean
}

export interface RequestsActions {
  onView?: (view: RequestsView) => void
  onFilters?: (filters: Filters) => void
  onMore?: () => void
  onRetry?: () => void
  onRetryCounts?: () => void
  onShowUpdates?: () => void
  onExport?: (ids: string[]) => void
  onOpen?: (requestId: string | null) => void
  onDismissNotice?: () => void
  detail?: {
    onSupplier?: (supplierId: string | null) => void
    onRetry?: () => void
    onDraft?: () => void
  }
  onDraft?: (requestIds: string[]) => void
  draft?: {
    onInto?: (key: string, into: 'existing' | 'new') => void
    onLeaveOutHeld?: () => void
    onRetry?: () => void
    onConfirm?: () => void
    onClose?: () => void
  }
  onReject?: (requestIds: string[]) => void
  reject?: {
    onReason?: (reason: SetAsideReason | '') => void
    onNote?: (note: string) => void
    onConfirm?: () => void
    onClose?: () => void
  }
}

/** The words a phrase holds may be keys themselves (a reason, a unit): translate those params first. */
export function say(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, words: Phrase): string {
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(words.params ?? {})) params[name] = typeof value === 'string' && /^(uom|reason)\.[A-Z0-9_]+$/.test(value) ? t(value) : value
  return t(words.key, params)
}
