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
 */

/** From this width the conversation docks beside the body. */
export const PORTAL_DOCK_FROM = 1280
/** Below this width the portal page is the phone's (PL4). */
export const PORTAL_PHONE_BELOW = 720

/** How the page shows the conversation at a width: docked beside the body, or behind the "Messages" button (full width). */
export type PortalFrameMode = 'docked' | 'stacked'

export function portalFrameMode(viewport: number): PortalFrameMode {
  return viewport >= PORTAL_DOCK_FROM ? 'docked' : 'stacked'
}

/** The body : conversation columns (the gap is the grid's): 3 : 2, so ~40 % at every width. */
export const PORTAL_DOCK_COLUMNS = 'minmax(0, 3fr) minmax(0, 2fr)'

/** The conversation's share of the portal's main area (for the design numbers: 40 % of ~1140 px is ~450 px with the gap). */
export function portalThreadPixels(main: number, gap = 16): number {
  return Math.round(((main - gap) * 2) / 5)
}

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
