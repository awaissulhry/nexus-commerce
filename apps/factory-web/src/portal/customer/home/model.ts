import type { ApprovalDecision, ApprovalKind, ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { milestonesOf } from '@nexus/factory-domain/sales/portal-orders/status'
import type { MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import type { Locale } from '../../../lib/i18n/locales'
import type { ApprovalRead, Conversation, CustomerDocument, DocumentsRead, HomeRead, OpenItemsRead, OrderRow, OrdersRead } from './api'

/**
 * SCR-183 — the customer's Home (design portal.customer.home; SAL-063, SAL-084, SAL-086), pure: the five numbers at a glance
 * and where each opens, the next deliveries as the customer reads them, the new documents, where Reply goes, which request
 * a row of What waits for you answers in the Approve pop-up, the first visit, the recent searches of this device and the
 * rules of the Approve pop-up. Money only where the person has the price grain (the Finance tile's amount); never cost.
 */

export const NS = 'portal-customer-home'

// ── at a glance ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One tile: a count of GET /portal/home, its words (keys of `portal-customer-home`), the list it opens (null: not built). */
export interface TileDef {
  readonly key: string
  readonly label: string
  readonly hint: string
  /** The page the count belongs to: a person who cannot open it gets no tile (fails closed). */
  readonly permission: string
  readonly href: string | null
  readonly tone?: 'danger' | 'warning'
}

/** Which of the portal's pages are built now (portal-nav.ts `built`): a tile links only to one of these. */
export interface BuiltPages {
  readonly orders: boolean
  readonly documents: boolean
  readonly returns: boolean
}

/**
 * The design's five ("Open orders · In production · Shipping this week · Invoices due (finance: count + amount) · Open
 * claims"), each from a count the API has; a Quality colleague who sees complaints but not returns counts its complaints.
 * "Shipping this week" counts PIECES promised Monday to Sunday; the orders list has no week chip, so it opens Open.
 */
export function tilesFor(built: BuiltPages, can: (permission: string) => boolean): TileDef[] {
  const orders = (chip: string) => (built.orders ? `/orders?chip=${chip}` : null)
  const claims: TileDef = can('portal.returns.view')
    ? { key: 'returns.open', label: 'tiles.claims', hint: 'tiles.claimsHint', permission: 'portal.returns.view', href: built.returns ? '/returns' : null, tone: 'warning' }
    : { key: 'returns.complaints_open', label: 'tiles.complaints', hint: 'tiles.complaintsHint', permission: 'portal.complaints.view', href: built.returns ? '/returns' : null, tone: 'warning' }
  return [
    { key: 'orders.open', label: 'tiles.open', hint: 'tiles.openHint', permission: 'portal.salesOrders.view', href: orders('OPEN') },
    { key: 'orders.in_production', label: 'tiles.inProduction', hint: 'tiles.inProductionHint', permission: 'portal.salesOrders.view', href: orders('IN_PRODUCTION') },
    { key: 'orders.shipping_this_week', label: 'tiles.shippingWeek', hint: 'tiles.shippingWeekHint', permission: 'portal.salesOrders.view', href: orders('OPEN') },
    { key: 'invoices.to_pay', label: 'tiles.invoices', hint: 'tiles.invoicesHint', permission: 'portal.payments.view', href: built.documents ? '/documents?group=FINANCE' : null },
    claims,
  ]
}

export interface Tile extends TileDef {
  /** null: it could not be counted (a dash, never 0). */
  readonly value: number | null
  /** The Finance tile: what is open and overdue, written per currency (price grain only). */
  readonly amount?: { readonly open: string; readonly overdue: number | null } | null
}

/** The tiles this person may open, with their counts (a tile whose page they cannot open is not drawn). */
export function tilesOf(defs: readonly TileDef[], home: HomeRead | null, can: (permission: string) => boolean, money?: { openItems: OpenItemsRead | null; format: (minor: number, currency: string) => string } | null): Tile[] {
  const byKey = new Map((home?.counts ?? []).map((count) => [count.key, count.value]))
  return defs
    .filter((def) => can(def.permission))
    .map((def) => {
      const value = byKey.get(def.key) ?? null
      if (def.key !== 'invoices.to_pay') return { ...def, value }
      const overdue = byKey.get('invoices.overdue') ?? null
      const totals = money?.openItems?.byCurrency.filter((row) => row.open !== undefined && row.open > 0) ?? []
      const open = totals.map((row) => money!.format(row.open!, row.currency)).join(' · ')
      return { ...def, value, tone: overdue && overdue > 0 ? 'danger' : undefined, amount: open ? { open, overdue } : overdue && overdue > 0 ? { open: '', overdue } : null }
    })
}

// ── the next deliveries ────────────────────────────────────────────────────────────────────────────────────────────────
export interface NextOrderRow {
  readonly id: string
  readonly kind: 'ORDER' | 'REQUEST'
  /** Their PO first, our number second (RefPair). */
  readonly theirs: string | null
  readonly ours: string | null
  readonly status: OrderRow['status']
  /** The six steps of the compact tracker, in the customer's words. */
  readonly steps: MilestoneStep[]
  /** The promise now (a day), else the date they asked for. */
  readonly promise: string | null
  readonly requested: string | null
  readonly moved: { readonly from: string; readonly to: string } | null
  /** Shown only when the account shares production progress (C1). */
  readonly progress: number | null
  readonly pieces: OrderRow['pieces']
  readonly shipment: { readonly number: string; readonly words: string } | null
  /** Where the card opens (its record; null for a request: no page of its own yet). */
  readonly href: string | null
}

const dayOnly = (value: string | null): string | null => (value ? value.slice(0, 10) : null)

/** The order rows as Home shows them: their PO first, the six steps from the status, the promise and how it moved. */
export function nextOrderRows(read: OrdersRead | null, locale: Locale, prefix: string, writeDay: (day: string) => string): NextOrderRow[] {
  if (!read) return []
  return read.items.map((row) => {
    const views = milestonesOf({ status: row.status, requestedOn: null, confirmedOn: null, productionOn: null, readyOn: null, firstShippedOn: null, allShippedOn: null, deliveredOn: null, promiseDate: dayOnly(row.promiseDate) })
    const steps: MilestoneStep[] = views.map((view) => ({
      id: view.key,
      label: view.words[locale],
      state: view.state === 'DONE' ? 'done' : view.state === 'PARTLY' ? 'partly' : view.state === 'SKIPPED' ? 'skipped' : 'todo',
      current: view.current,
      expected: view.expected ? writeDay(view.expected) : null,
    }))
    const from = dayOnly(row.originalPromiseDate)
    const to = dayOnly(row.promiseDate)
    return {
      id: row.id,
      kind: row.kind,
      theirs: row.customerRef,
      ours: row.number,
      status: row.status,
      steps,
      promise: to,
      requested: dayOnly(row.requestedDate),
      moved: row.promiseMoved && from && to && from !== to ? { from, to } : null,
      progress: read.progressShared && row.progressPercent !== null ? Math.max(0, Math.min(100, Math.round(row.progressPercent))) : null,
      pieces: row.pieces,
      shipment: row.nextShipment ? { number: row.nextShipment.number, words: row.nextShipment.words[locale] } : null,
      href: row.kind === 'ORDER' ? `${prefix}/open/SalesOrder/${encodeURIComponent(row.id)}` : null,
    }
  })
}

/** The Open chip's count ("See all 23 open orders"), and whether the customer has any order at all (the first visit). */
export function orderCounts(read: OrdersRead | null): { open: number | null; all: number | null } {
  if (!read) return { open: null, all: null }
  const of = (chip: string) => read.chips.find((entry) => entry.chip === chip)?.count ?? null
  return { open: of('OPEN') ?? read.count, all: of('ALL') }
}

// ── the new documents ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface DocumentRow {
  readonly id: string
  readonly title: string
  readonly kind: string
  /** "Order SO-…" or the record it is of. */
  readonly forWords: { readonly key: 'documents.forOrder' | 'documents.for'; readonly params: Readonly<Record<string, string>> } | null
  readonly date: string
  readonly version: number
  readonly isNew: boolean
  /** A PDF (or a picture) can be previewed; an XML or other file is downloaded. */
  readonly previewable: boolean
  readonly fileName: string
  readonly sizeBytes: number | null
}

const PREVIEWABLE = /^(application\/pdf|image\/(png|jpe?g|webp|gif))\b/i

export const mainFileOf = (document: Pick<CustomerDocument, 'files'>) => document.files.find((file) => file.format === 'PDF') ?? document.files[0] ?? null

export function documentRowOf(document: CustomerDocument, locale: Locale): DocumentRow {
  const file = mainFileOf(document)
  const order = document.for?.order ?? null
  const label = document.for?.label ?? null
  return {
    id: document.id,
    title: document.title[locale],
    kind: document.kind,
    forWords: order ? { key: 'documents.forOrder', params: { number: order.customerRef ? `${order.customerRef} · ${order.number}` : order.number } } : label ? { key: 'documents.for', params: { label } } : null,
    date: document.date,
    version: document.version,
    isNew: document.new,
    previewable: file ? PREVIEWABLE.test(file.contentType) : false,
    fileName: file?.name ?? document.title[locale],
    sizeBytes: file?.sizeBytes ?? null,
  }
}

export const documentRows = (read: DocumentsRead | null, locale: Locale): DocumentRow[] => (read ? read.items.map((item) => documentRowOf(item, locale)) : [])

/** The versions line of the document pop-up: "v3 replaced v2 on 12 Oct", newest first. */
export function versionLines(versions: readonly Pick<CustomerDocument, 'id' | 'version' | 'date' | 'current'>[]): { id: string; version: number; previous: number | null; date: string; current: boolean }[] {
  const sorted = [...versions].sort((a, b) => b.version - a.version)
  return sorted.map((entry, index) => ({ id: entry.id, version: entry.version, previous: sorted[index + 1]?.version ?? null, date: entry.date, current: entry.current }))
}

/** The document after or before this one in the list (J / K in the pop-up), or null at an end. */
export function neighbourOf(ids: readonly string[], id: string, step: 1 | -1): string | null {
  const at = ids.indexOf(id)
  if (at < 0) return null
  return ids[at + step] ?? null
}

// ── our last messages ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Where "Reply" goes: the record's Messages with the composer (its own page once built, else the frame's record page). */
export function replyHref(prefix: string, conversation: Pick<Conversation, 'record'>, recordPage: (type: string, id: string) => string | null): string {
  const { type, id } = conversation.record
  const own = recordPage(type, id)
  if (own) return `${prefix}${own}${own.includes('?') ? '&' : '?'}tab=messages#messages`
  return `${prefix}/open/${encodeURIComponent(type)}/${encodeURIComponent(id)}#messages`
}

// ── What waits for you: the rows the Approve pop-up answers ────────────────────────────────────────────────────────────
const APPROVAL_TASK_KINDS: ReadonlySet<string> = new Set(['APPROVE', 'RECONFIRM_ORDER'])

/** The approval request a task row asks to answer (its link names it), or null: the row keeps its own verb. */
export function approvalOfTask(row: { kind: string; href: string }): string | null {
  if (!APPROVAL_TASK_KINDS.has(row.kind)) return null
  const match = /\/open\/ApprovalRequest\/([0-9a-f-]{36})/i.exec(row.href)
  return match ? match[1]! : null
}

/** The waiting approvals in the list's order (J / K in the pop-up). */
export function approvalIds(groups: readonly { rows: readonly { kind: string; href: string; done?: unknown }[] }[]): string[] {
  return groups.flatMap((group) => group.rows.filter((row) => !row.done).map(approvalOfTask)).filter((id): id is string => id !== null)
}

// ── the Approve pop-up (B-W2b-184's portal page; the same rules as the Approve link, SCR-198) ──────────────────────────
/** The limits the API checks (factory-domain approvals-out/rules APPROVAL_LIMITS: that module is server-only). */
export const ANSWER_LIMITS = Object.freeze({ answer: 4000, typedName: 200 })

/** Approve · Approve with changes (where the kind allows) · Refuse. */
export const decisionsOf = (page: Pick<ApprovalRead, 'may'>): ApprovalDecision[] => (page.may.withChanges ? ['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'] : ['APPROVED', 'REFUSED'])

/** Words are needed with changes and with a refusal (the API refuses either without). */
export const commentNeeded = (decision: ApprovalDecision | null): boolean => decision === 'APPROVED_WITH_CHANGES' || decision === 'REFUSED'

/** Why the signed answer cannot go yet (a key of `portal-customer-home`), in the order the person fixes it. */
export function answerProblem(decision: ApprovalDecision | null, comment: string): { key: string; field: 'decision' | 'comment' } | null {
  if (decision === null) return { key: 'approve.problem.choose', field: 'decision' }
  const words = comment.trim()
  if (decision === 'REFUSED' && words === '') return { key: 'approve.problem.why', field: 'comment' }
  if (decision === 'APPROVED_WITH_CHANGES' && words === '') return { key: 'approve.problem.what', field: 'comment' }
  if (words.length > ANSWER_LIMITS.answer) return { key: 'approve.problem.long', field: 'comment' }
  return null
}

/** A refused answer in this page's words (`reload`: read the request again). */
export function answerRefusal(kind: string | null): { key: string; reload?: boolean; gone?: boolean } {
  switch (kind) {
    case 'not_found':
      return { key: 'approve.problem.gone', gone: true }
    case 'forbidden':
      return { key: 'approve.problem.forbidden' }
    case 'conflict':
      return { key: 'approve.problem.changed', reload: true }
    case 'invalid':
      return { key: 'approve.problem.invalid' }
    case 'unavailable':
    case 'rate_limited':
      return { key: 'approve.problem.unavailable' }
    default:
      return { key: 'approve.problem.internal' }
  }
}

/** Why the pop-up cannot take an answer (a key), from the request itself: answered, withdrawn or past its date. */
export function requestHeld(page: Pick<ApprovalRead, 'may' | 'request'>): string | null {
  if (page.may.answer) return null
  const status: ApprovalStatus = page.request.status
  return status === 'APPROVED' || status === 'APPROVED_WITH_CHANGES' || status === 'REFUSED' ? 'held.answered' : 'held.closed'
}

/** The reference a request names, without the API's own words after it ("SO-2026-0042 · line 2" → "SO-2026-0042"). */
export const referenceOf = (label: string): string => label.split(' · ')[0]!.trim()

/** The pop-up's title: the kind in our words and the reference (a revised order names its revision). */
export function approvalTitle(page: Pick<ApprovalRead, 'request' | 'content'>, t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
  const order = page.content.revisedOrder
  const label = order ? t('approve.order', { number: order.orderNumber, revision: order.revision }) : referenceOf(page.request.label)
  return t('approve.title', { kind: t(`kind.${page.request.kind satisfies ApprovalKind}`), label })
}

/** The answer's tone on the end (an approval succeeds; a refusal is said plainly). */
export const decidedTone = (status: ApprovalStatus): 'success' | 'warning' | 'neutral' => (status === 'REFUSED' ? 'warning' : status === 'APPROVED' || status === 'APPROVED_WITH_CHANGES' ? 'success' : 'neutral')

export const isPicture = (contentType: string): boolean => /^image\/(png|jpe?g|webp|gif)$/i.test(contentType.split(';')[0]!.trim())
export const isPdf = (contentType: string): boolean => contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf'

// ── the first visit ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A new customer with no order sees a clear first step instead of empty panels: nothing waits for them, there is no order
 * at all (or their role does not see orders) and no new document. Undecided while the reads are on their way.
 */
export function isFirstVisit(input: { tasks: 'loading' | 'error' | 'ready'; openTasks: number; seesOrders: boolean; ordersAll: number | null; newDocuments: number | null }): boolean {
  if (input.tasks !== 'ready' || input.openTasks > 0) return false
  if (input.seesOrders && input.ordersAll !== 0) return false
  return !input.newDocuments
}

// ── recent searches (this device) ──────────────────────────────────────────────────────────────────────────────────────
export const RECENT_SEARCHES = 5
export const recentSearchesKey = (userId: string): string => `fw-portal-recent-searches:${userId}`

/** The searches kept, newest first, without repeats (case aside), at most five. */
export function withRecent(list: readonly string[], query: string, max = RECENT_SEARCHES): string[] {
  const words = query.trim()
  if (words.length < 2) return [...list]
  return [words, ...list.filter((entry) => entry.toLowerCase() !== words.toLowerCase())].slice(0, max)
}

/** What the device kept, read safely (anything odd is nothing). */
export function readRecent(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_SEARCHES) : []
  } catch {
    return []
  }
}
