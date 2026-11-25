import { DOCK_COLUMNS, DOCK_FROM, frameMode, isThreadKey, type FrameMode } from '../../../lib/record-frame/model' // pp-k1 k1.3: the frame's core
import { DOCK_WIDTHS, type DockWidth } from '../../../lib/record-thread/head/model' // pp-k1 k1.3: the dock's widths

/**
 * B-TH-273 — the portal record frame (threads plan PL3; design kit §2; tree E "Portal record pages"; feature PL3-F03): the pure
 * part, held by record-frame.vitest.test.ts. Every portal record page (a customer's order, return, complaint, repair; a supplier's
 * purchase order and delivery notice; a workshop's job; the accountant's room) docks the record's ONE conversation like the office:
 *
 * - From 1280 px the conversation is DOCKED on the right, ~40 % of the portal's main area (a 3 : 2 grid, gap 16: 1440 → ~456 px of
 *   the ~1140 px main, 1920 → ~648 px of ~1620), sticky while the body scrolls, its own scroll, the box at its foot.
 * - Below 1280 px the body leads and a "Messages" button ("Messages (2 new)") opens the conversation full width; Back returns to
 *   the same tab and scroll. On a phone the same (PL4).
 * - No Messages tab and no Ask modal: the frame's ⋯ "Ask a question" focuses the docked box (it opens the full-width view first
 *   when the page is narrower); an old `?tab=messages` address opens the record's first tab with the conversation shown (R-8).
 * - ONE conversation per page; notices stay in the body column, never above the conversation.
 *
 * pp-k1 k1.3 (O2-B3): this file held a declared copy of the office frame's numbers (where it docks, the columns, ⌘J) and nothing
 * kept them equal. It reads the shared core now (lib/record-frame/model.ts, which also holds PHONE_BELOW, threadPixels and the
 * office's first-width rule defaultWidthAt). The portal names below stay, each the core's own value, so no host is renamed; the
 * portal keeps its three widths (no `full`: a portal record page keeps its body). record-frame-core.vitest.test.ts pins them equal.
 */

/** From this width the conversation docks beside the body (the core's DOCK_FROM). */
export const PORTAL_DOCK_FROM = DOCK_FROM

/** How the page shows the conversation at a width: docked beside the body, or behind the "Messages" button (full width). */
export type PortalFrameMode = FrameMode

/** The core's frameMode: docked from PORTAL_DOCK_FROM, else stacked. */
export const portalFrameMode: (viewport: number) => PortalFrameMode = frameMode

/** The body : conversation columns (the gap is the grid's): 3 : 2, so ~40 % at every width (the core's 40 %). */
export const PORTAL_DOCK_COLUMNS: string = DOCK_COLUMNS.forty

// ---- F-SA-264 (sales page plan N6, R6, P11, P20): the portal frame gets the office's width menu (a third · 40 % · half) and Hide /
// Show (⌘J), remembered on this device per person (a private window keeps nothing). Factory code only: PartnerThread is untouched.
/** pp-k1: the office dock's widths but `full`, in the office's order. */
export type PortalDockWidth = Exclude<DockWidth, 'full'>
export const PORTAL_DOCK_WIDTHS: readonly PortalDockWidth[] = DOCK_WIDTHS.filter((width): width is PortalDockWidth => width !== 'full')
export const DEFAULT_PORTAL_DOCK_WIDTH: PortalDockWidth = 'forty'

/** The body : conversation columns of each width (the gap is the grid's): the office dock's own (the core's DOCK_COLUMNS). */
export const PORTAL_DOCK_COLUMNS_OF: Readonly<Record<PortalDockWidth, string>> = {
  third: DOCK_COLUMNS.third,
  forty: DOCK_COLUMNS.forty,
  half: DOCK_COLUMNS.half,
}

export const isPortalDockWidth = (value: unknown): value is PortalDockWidth => typeof value === 'string' && (PORTAL_DOCK_WIDTHS as readonly string[]).includes(value)

/** Where the width and "hidden" are kept on this device: per signed-in person (one portal person, every record page). */
export const portalWidthKey = (personId: string) => `fw-portal.thread.width.${personId}`
export const portalHiddenKey = (personId: string) => `fw-portal.thread.hidden.${personId}`

/** What the person left on this device: the width (40 % when none) and whether the conversation was hidden. Closed storage: the defaults. */
export function readPortalDock(storage: Pick<Storage, 'getItem'> | null, personId: string): { readonly width: PortalDockWidth; readonly hidden: boolean } {
  try {
    const width = storage?.getItem(portalWidthKey(personId))
    return { width: isPortalDockWidth(width) ? width : DEFAULT_PORTAL_DOCK_WIDTH, hidden: storage?.getItem(portalHiddenKey(personId)) === '1' }
  } catch {
    return { width: DEFAULT_PORTAL_DOCK_WIDTH, hidden: false }
  }
}

/** Keeps a width (40 %, the default, forgets it) or hidden (false forgets it). A closed storage (a private window) forgets quietly. */
export function writePortalDock(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, personId: string, change: { readonly width?: PortalDockWidth; readonly hidden?: boolean }): void {
  try {
    if (change.width !== undefined) {
      if (change.width === DEFAULT_PORTAL_DOCK_WIDTH) storage?.removeItem(portalWidthKey(personId))
      else storage?.setItem(portalWidthKey(personId), change.width)
    }
    if (change.hidden !== undefined) {
      if (change.hidden) storage?.setItem(portalHiddenKey(personId), '1')
      else storage?.removeItem(portalHiddenKey(personId))
    }
  } catch {
    // Only a convenience of this device.
  }
}

/** ⌘J (Ctrl J on other systems): hide or show the docked conversation, open or close the full-width one. Never with Alt or Shift. The core's isThreadKey. */
export const isPortalThreadKey: typeof isThreadKey = isThreadKey

/** "Show the conversation", or "Show the conversation (2 new)" with the person's own new messages (99+ above 99). */
export function showButtonWords(count: number): { readonly key: 'record.frame.show' | 'record.frame.showNew' | 'record.frame.showMany'; readonly count?: number } {
  if (count <= 0) return { key: 'record.frame.show' }
  return count > 99 ? { key: 'record.frame.showMany', count: 99 } : { key: 'record.frame.showNew', count }
}
// ---- end F-SA-264

/** The portal's main area at a window width: the window less the rail (240) and the main's padding (2 × 30), as PL3 measures it. */
export function portalMainPixels(viewport: number): number {
  return Math.max(0, viewport - 240 - 60)
}

/** The address term that keeps the full-width conversation open below 1280 px (Back closes it: the browser's history holds it). */
export const PORTAL_THREAD_PARAM = 'thread'

/**
 * What an address asks of the frame on arrival (R-8: every old address keeps working): an old `?tab=messages` (a list's Messages
 * link, a mail, a notification), `?thread=new` (a list's new-messages mark) or the anchor `#messages` shows the conversation; the
 * page's own tab rule then opens its first tab for `messages` (`tabOrFirst`). `?thread=open` is the narrow page's own view: kept.
 */
export function portalArrivalOf(search: string | { get(name: string): string | null } | null | undefined, hash = ''): { readonly openThread: boolean; readonly focus: boolean } {
  const anchor = hash === '#messages'
  if (!search) return { openThread: anchor, focus: false }
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search : `?${search}`) : search
  const old = params.get('tab') === 'messages'
  const fresh = params.get(PORTAL_THREAD_PARAM) === 'new'
  return { openThread: old || fresh || anchor, focus: old }
}

/** The address without the arrival terms the frame took (`tab=messages`, `thread=new`); the narrow view's `thread=open` when asked. */
export function portalArrivalCleaned(search: string, openNarrow: boolean): string {
  const next = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  if (next.get('tab') === 'messages') next.delete('tab')
  if (next.get(PORTAL_THREAD_PARAM) === 'new') next.delete(PORTAL_THREAD_PARAM)
  if (openNarrow) next.set(PORTAL_THREAD_PARAM, 'open')
  const query = next.toString()
  return query ? `?${query}` : ''
}

/**
 * A page's tab from the address: one of its tabs, else its first — an old `?tab=messages` (the Messages tab is gone: the frame
 * shows the conversation) or `?tab=documents` on a page that merged it lands on the first tab. `Object.hasOwn`-safe: a key of
 * Object.prototype is never a tab.
 */
export function tabOrFirst<T extends string>(tabs: readonly T[], asked: string | null | undefined, merged: Readonly<Record<string, T>> = {}): T {
  if (asked && (tabs as readonly string[]).includes(asked)) return asked as T
  if (asked && Object.prototype.hasOwnProperty.call(merged, asked)) return merged[asked]!
  return tabs[0]!
}

/**
 * The "Messages" button below 1280 px (PL3-F03): "Messages", or "Messages (2 new)" with the person's own new messages (99+ above
 * 99); the screen reader hears "Messages, 2 new". The count is the person's own reading (B-TH-027), never anyone else's.
 */
export function messagesButtonWords(count: number): { readonly key: 'record.frame.messages' | 'record.frame.messagesNew' | 'record.frame.messagesMany'; readonly count?: number; readonly label: { readonly key: 'record.frame.messagesNewLabel'; readonly count: number } | null } {
  if (count <= 0) return { key: 'record.frame.messages', label: null }
  const shown = Math.min(count, 99)
  return { key: count > 99 ? 'record.frame.messagesMany' : 'record.frame.messagesNew', count: shown, label: { key: 'record.frame.messagesNewLabel', count: shown } }
}

/**
 * B-TH-274 / B-TH-276 (P-ANY, PL5): a record's conversation as its own page — the portal's generic page `/open/<type>/<id>` with
 * `view=conversation`, which never sends on to the record's own page (an invoice's "Ask about this invoice": its conversation, not
 * the Documents library). `Party` with the person's own party id is the account conversation ("Ask us a question").
 */
export const CONVERSATION_VIEW = 'conversation'

export function conversationHref(prefix: string, record: { readonly type: string; readonly id: string }): string {
  return `${prefix}/open/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}?view=${CONVERSATION_VIEW}`
}

/** The account conversation (a question with no record): the generic page of the person's own party. */
export function accountConversationHref(prefix: string, partyId: string): string {
  return `${prefix}/open/Party/${encodeURIComponent(partyId)}`
}

/** The route's rule: a record whose own page is built opens it, unless the address asks for its conversation page. */
export function opensOwnPage(page: string | null, view: string | string[] | null | undefined): boolean {
  return page !== null && view !== CONVERSATION_VIEW
}

/**
 * B-TH-274 (P-ANY.summary): the summary's state pill tone from the state code the partner view gives (only words of real states;
 * the tone is a reading aid): finished well → success, waiting on the person or held → warning, refused or ended → neutral,
 * anything else in progress → info.
 */
export type SummaryTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
const DONE = new Set(['DELIVERED', 'SHIPPED', 'CLOSED', 'PAID', 'COMPLETED', 'COMPLETE', 'APPROVED', 'ACCEPTED', 'DONE', 'RECEIVED', 'RESOLVED', 'RETURNED', 'CONFIRMED', 'ORDERED', 'ACTIVE'])
const WAITING = new Set(['PENDING_APPROVAL', 'NEED_INFO', 'ON_HOLD', 'HELD', 'OVERDUE', 'AWAITING_CUSTOMER', 'WAITING', 'PARTIALLY_PAID'])
const ENDED = new Set(['CANCELLED', 'CANCELED', 'DECLINED', 'REJECTED', 'VOID', 'VOIDED', 'ARCHIVED', 'LOST', 'WITHDRAWN', 'EXPIRED', 'NOT_AN_ORDER', 'INACTIVE'])
export function summaryTone(code: string | null | undefined): SummaryTone {
  if (!code) return 'neutral'
  if (DONE.has(code)) return 'success'
  if (WAITING.has(code)) return 'warning'
  if (ENDED.has(code)) return 'neutral'
  return 'info'
}

/** The generic page's link to the record a summary belongs to: its `/open/` address (the route opens its own page when built). */
export function parentHref(prefix: string, parent: { readonly recordType: string; readonly recordId: string }): string {
  return `${prefix}/open/${encodeURIComponent(parent.recordType)}/${encodeURIComponent(parent.recordId)}`
}

/**
 * B-TH-273: the record types whose own portal page docks THEIR conversation in the record frame (an order, a return, a complaint, a
 * repair, a purchase order, a job). "Ask a question" about one of them from another page (Documents' "Ask us for it" about an order)
 * opens that page with the conversation shown and its box focused (`?tab=messages`: the frame's arrival rule) — not a second copy
 * of the conversation; any other record opens its conversation page (`conversationHref`).
 */
export const DOCKED_RECORD_TYPES: ReadonlySet<string> = new Set(['SalesOrder', 'ReturnAuthorisation', 'Complaint', 'RepairOrder', 'PurchaseOrder', 'SubcontractOrder'])

/** Where "Ask a question" about a record goes from a page that does not dock it: its own page's docked box, else its conversation page. */
export function askHref(prefix: string, record: { readonly type: string; readonly id: string }, ownPage: string | null): string {
  if (ownPage && DOCKED_RECORD_TYPES.has(record.type) && !ownPage.includes('?') && !ownPage.includes('#')) return `${prefix}${ownPage}?tab=messages`
  return conversationHref(prefix, record)
}
