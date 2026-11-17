import type { ApprovalDecision, ApprovalKind, ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { milestonesOf } from '@nexus/factory-domain/sales/portal-orders/status'
import type { MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import type { Locale } from '../../../lib/i18n/locales'
import { isPreviewable, mainFileOf } from '../documents/preview/model'
import type { ApprovalRead, Conversation, CustomerDocument, DocumentsRead, HomeRead, OpenItemsRead, OrderRow, OrdersRead } from './api'
// B-TH-253: the projects the person was added to join the Messages card (PROJ.portal-F01).
import type { ProjectStatus } from '@nexus/factory-domain/projects/rules'
import type { PortalProject } from '../projects/api'
// B-TH-238: the Messages card reads the customer's requests (its own numbers and true states, never an office series).
import type { RequestRow } from '../requests/api'
import { requestHref, requestOrder, yourNumberText } from '../requests/model'

// The document pop-up's rules are the documents' own (lifted by B-W2b-195); Home reads them from there.
export { isPdf, isPicture, neighbourOf } from '../documents/preview/model'

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
  /** Their PO first, then the customer's own number (RefPair: "Your order" · "12"; B-TH-303 — never the office's series). */
  readonly theirs: string | null
  readonly ours: string | null
  readonly oursLabel: string | null
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
      // B-TH-303
      ours: row.yourNumber ? String(row.yourNumber.seq) : null,
      oursLabel: row.yourNumber ? row.yourNumber.words[locale].replace(new RegExp(`\\s*${row.yourNumber.seq}$`), '') : null,
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
    previewable: file ? isPreviewable(file.contentType) : false,
    fileName: file?.name ?? document.title[locale],
    sizeBytes: file?.sizeBytes ?? null,
  }
}

export const documentRows = (read: DocumentsRead | null, locale: Locale): DocumentRow[] => (read ? read.items.map((item) => documentRowOf(item, locale)) : [])

// ── our last messages ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Where "Reply" goes: the record's Messages with the composer (its own page once built, else the frame's record page). */
export function replyHref(prefix: string, conversation: Pick<Conversation, 'record'>, recordPage: (type: string, id: string) => string | null): string {
  const { type, id } = conversation.record
  const own = recordPage(type, id)
  if (own) return `${prefix}${own}${own.includes('?') ? '&' : '?'}tab=messages#messages`
  return `${prefix}/open/${encodeURIComponent(type)}/${encodeURIComponent(id)}#messages`
}

// ── B-TH-238 (P-HOME.messages): the Messages card — what needs the customer first, then new messages, the account's conversation ──
/** One row of the Messages card, as the view draws it (words resolved by the view from `kind` and the facts). */
export interface MessageRow {
  readonly key: string
  // B-TH-253: 'project' — a project the person was added to (even before a first message), named by its name.
  readonly kind: 'needsYou' | 'conversation' | 'account' | 'project'
  /** Where it opens: the request's page, the record's page with its thread in view, the account's conversation. */
  readonly href: string
  /** Their reference and the customer's own one (never an office series: the API's partner views say "#7"). */
  readonly theirs: string | null
  readonly ours: string | null
  /** A request's own number in words ("Your request 7") and subject; a record's subtitle. */
  readonly yours: string | null
  readonly subject: string | null
  /** A request's true state in the page's language (needsYou rows). */
  readonly state: string | null
  /** The last message: from the customer's side or ours, and when; null when none yet. */
  readonly last: { readonly from: 'you' | 'us'; readonly at: string; readonly excerpt: string | null } | null
  /** The messages new to this person (its own read marks; the party's shared messages only). */
  readonly newCount: number
  /** B-TH-253 (project rows): its status in one word and its target date; null where only its conversation was read. */
  readonly project?: { readonly status: ProjectStatus | null; readonly targetDate: string | null }
}

export interface MessagesCard {
  /** Requests waiting for the customer's answer (NEED_INFO), as Orders & requests orders them (their last move, newest first). */
  readonly needsYou: readonly MessageRow[]
  /** How many requests need the customer in all (the API's count: the same number as Orders & requests' first tile). */
  readonly needsYouCount: number
  /** Conversations with new messages first, then by their last message. */
  readonly conversations: readonly MessageRow[]
  /** The account's own conversation (questions about no record): always offered. */
  readonly account: MessageRow
  /** More conversations than the card shows. */
  readonly more: number
  /**
   * B-TH-253 (PROJ.portal-F01): the projects the person was added to — the open ones even before a first message, a closed one
   * while its conversation is among the recent ones —, new messages first, then the API's order (target date). Named by their
   * name, never the office's project number. A project's conversation is not repeated among the conversations.
   */
  readonly projects: readonly MessageRow[]
  /** More projects than the card shows. */
  readonly projectsMore: number
}

export const MESSAGES_NEEDS_YOU = 3
export const MESSAGES_CONVERSATIONS = 5
/** B-TH-253: the most project rows the card shows. */
export const MESSAGES_PROJECTS = 3

/**
 * The Messages card from the session's OWN reads only (GET /portal/inquiries?state=OPEN for what needs the customer, GET
 * /portal/threads for every conversation it may read with its new messages, POST /threads/unread for the waiting requests): a
 * request that needs the customer comes first (and is not repeated among the conversations), then the conversations with new
 * messages, then by last message; the account's conversation last, always (its page opens it even before a first message).
 * Nothing here is shared between sign-ins: another customer's rows never reach these reads (W05, W06, W08).
 */
export function messagesCardOf(input: {
  readonly prefix: string
  readonly partyId: string
  readonly locale: Locale
  readonly waiting: readonly RequestRow[]
  readonly needsYouCount: number | null
  readonly conversations: readonly Conversation[]
  /** New messages per waiting request id (POST /threads/unread). */
  readonly unread: Readonly<Record<string, number>>
  readonly recordPage: (type: string, id: string) => string | null
  /** B-TH-253: GET /portal/projects (the projects the person was added to); absent or empty without portal.projects.view. */
  readonly projects?: readonly PortalProject[]
}): MessagesCard {
  const asked = requestOrder(input.waiting).filter((row) => row.state.needsYou)
  const shownAsked = asked.slice(0, MESSAGES_NEEDS_YOU)
  const askedIds = new Set(asked.map((row) => row.id))
  const conversationOf = new Map(input.conversations.map((conversation) => [`${conversation.record.type}:${conversation.record.id}`, conversation]))
  const lastOf = (conversation: Conversation | undefined): MessageRow['last'] => (conversation ? { from: conversation.last.side === 'PARTNER' ? 'you' : 'us', at: conversation.last.at, excerpt: conversation.last.excerpt || null } : null)
  const needsYou = shownAsked.map((row): MessageRow => {
    const conversation = conversationOf.get(`Inquiry:${row.id}`)
    return {
      key: `Inquiry:${row.id}`,
      kind: 'needsYou',
      href: requestHref(input.prefix, row.id),
      theirs: row.customerRef,
      ours: null,
      yours: yourNumberText(row.yourNumber, input.locale),
      subject: row.subject,
      state: row.state.words[input.locale],
      last: lastOf(conversation),
      newCount: Math.max(input.unread[row.id] ?? 0, conversation?.newCount ?? 0),
    }
  })
  const others = input.conversations
    // B-TH-253: a project's conversation is its project row (named by its name), never a conversation row with the office's number.
    .filter((conversation) => conversation.record.type !== 'Party' && conversation.record.type !== 'Project' && !(conversation.record.type === 'Inquiry' && askedIds.has(conversation.record.id)))
    // New messages first (the order of the API — the newest message first — kept inside each part).
    .map((conversation, index) => ({ conversation, index }))
    .sort((a, b) => Number(b.conversation.newCount > 0) - Number(a.conversation.newCount > 0) || a.index - b.index)
    .map(({ conversation }) => conversation)
  const conversations = others.slice(0, MESSAGES_CONVERSATIONS).map(
    (conversation): MessageRow => ({
      key: `${conversation.record.type}:${conversation.record.id}`,
      kind: 'conversation',
      href: replyHref(input.prefix, conversation, input.recordPage),
      theirs: conversation.record.theirRef,
      ours: conversation.record.ourRef,
      yours: null,
      subject: conversation.record.subtitle,
      state: null,
      last: lastOf(conversation),
      newCount: conversation.newCount,
    }),
  )
  const accountConversation = input.conversations.find((conversation) => conversation.record.type === 'Party' && conversation.record.id === input.partyId)
  const account: MessageRow = {
    key: `Party:${input.partyId}`,
    kind: 'account',
    href: `${input.prefix}/open/Party/${encodeURIComponent(input.partyId)}#messages`,
    theirs: null,
    ours: null,
    yours: null,
    subject: null,
    state: null,
    last: lastOf(accountConversation),
    newCount: accountConversation?.newCount ?? 0,
  }
  // ---- B-TH-253: the project rows
  const listed = input.projects ?? []
  const listedIds = new Set(listed.map((project) => project.id))
  const projectEntries = [
    ...listed.filter((project) => project.status !== 'CLOSED' || conversationOf.has(`Project:${project.id}`)).map((project) => ({ id: project.id, project, conversation: conversationOf.get(`Project:${project.id}`) })),
    ...input.conversations.filter((conversation) => conversation.record.type === 'Project' && !listedIds.has(conversation.record.id)).map((conversation) => ({ id: conversation.record.id, project: null, conversation })),
  ]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Number((b.entry.conversation?.newCount ?? 0) > 0) - Number((a.entry.conversation?.newCount ?? 0) > 0) || a.index - b.index)
    .map(({ entry }) => entry)
  const projects = projectEntries.slice(0, MESSAGES_PROJECTS).map(({ id, project, conversation }): MessageRow => {
    const own = input.recordPage('Project', id)
    return {
      key: `Project:${id}`,
      kind: 'project',
      href: own ? `${input.prefix}${own}#messages` : `${input.prefix}/open/Project/${encodeURIComponent(id)}#messages`,
      // Never the office's project number (an office series counts every customer's projects): the name names it.
      theirs: null,
      ours: null,
      yours: null,
      subject: project?.name ?? conversation?.record.subtitle ?? null,
      state: null,
      last: lastOf(conversation),
      newCount: conversation?.newCount ?? 0,
      project: { status: project?.status ?? null, targetDate: project?.targetDate ?? null },
    }
  })
  // ---- end B-TH-253
  return { needsYou, needsYouCount: input.needsYouCount ?? asked.length, conversations, account, more: Math.max(0, others.length - conversations.length), projects, projectsMore: Math.max(0, projectEntries.length - projects.length) }
}

/** The card's numbers (what needs the customer, its new messages): what a test holds still while another customer moves. */
export function messagesCountsOf(card: MessagesCard): { readonly needsYou: number; readonly newMessages: number; readonly conversations: number } {
  const rows = [...card.needsYou, ...card.projects, ...card.conversations, card.account]
  return { needsYou: card.needsYouCount, newMessages: rows.reduce((sum, row) => sum + row.newCount, 0), conversations: card.conversations.length + card.more }
}

/** Nothing to show but the account's offer (the card says "No messages yet" above it). */
export const messagesEmpty = (card: MessagesCard): boolean => card.needsYou.length === 0 && card.projects.length === 0 && card.conversations.length === 0 && card.account.last === null
// ── end B-TH-238

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

// ── the first visit ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * A new customer with no order sees a clear first step instead of empty panels: nothing waits for them, there is no order
 * at all (or their role does not see orders) and no new document. Undecided while the reads are on their way.
 */
export function isFirstVisit(input: { tasks: 'loading' | 'error' | 'ready'; openTasks: number; seesOrders: boolean; ordersAll: number | null; newDocuments: number | null; requestsAll?: number | null }): boolean {
  if (input.tasks !== 'ready' || input.openTasks > 0) return false
  if (input.seesOrders && input.ordersAll !== 0) return false
  // B-TH-223: a customer who sent a request (any door) is past its first step; unknown yet = not a first visit (no flicker).
  if (input.seesOrders && input.requestsAll !== undefined && input.requestsAll !== 0) return false
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
