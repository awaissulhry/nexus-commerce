import { DOCK_FROM } from '../../../lib/record-frame/model' // pp-k1 k1.2: the frame's core

/**
 * F-OP-209 (order page plan N4; 11-dock §4; review R-19, RC4, RC5) — the record page's address, ONE writer of `thread=`.
 *
 * `thread=` holds what the dock shows (a scope the page's pick keeps: `general`, `project:<id>`, `wo:<id>`, `all`) and, below
 * 1280 px, that the full-width view is open (`open`, or the scope itself); `new` is an arrival the frame takes once; `message=` is
 * the message a link opens its thread at. Before this step four writers touched it (the frame's history writes, the dock's
 * `router.replace`, the tab links, the page's in-page moves) and every tab link dropped it, so the dock jumped back to This order.
 *
 * The rules (fx-12 #1697 / #1698 kept: an address is written only when it differs — no writer can feed another):
 *   - `withThread` sets or drops the term (and `message=`), keeping every other term and the hash: applied twice it is the same.
 *   - `tabHref` (a tab's link) and `tabAddress` (an in-page move: Amend, Show on the page, Still to do, landing) keep a scope and
 *     drop `open`, `new` and `message=`; below 1280 px an in-page move drops the term (the page gives way to the tab: the frame keeps
 *     the scope, `keptScopeOf`, and its Thread button opens on it again).
 *   - `writeSearch` is the one history writer: nothing when the address is the same, a replace by default (Back leaves the page, not
 *     a pick), a push only when the narrow full-width view opens (Back closes it). Next 16 syncs `useSearchParams` with the history
 *     API, so a pick asks the server nothing (RC5).
 * Pure but for `writeSearch` / `currentAddress` / `narrowNow`, which take the window (or a stand-in in a test).
 */

/** The address term of the dock (the frame's own: `open` is the narrow view, `new` an arrival). */
export const THREAD_TERM = 'thread'
/** The address term of the message a link opens its thread at (the thread's own anchor, `anchorOf`). */
export const MESSAGE_TERM = 'message'

type Search = string | { toString(): string } | null | undefined

/** An address cut in its three parts (path, terms, hash); a bare search (`?a=b` or `a=b`) has no path. */
function partsOf(address: string): { path: string; query: URLSearchParams; hash: string } {
  const at = address.indexOf('#')
  const hash = at >= 0 ? address.slice(at) : ''
  const rest = at >= 0 ? address.slice(0, at) : address
  const mark = rest.indexOf('?')
  if (mark >= 0) return { path: rest.slice(0, mark), query: new URLSearchParams(rest.slice(mark + 1)), hash }
  // No `?`: a path (starts with `/`), or the terms alone (`a=b`).
  return rest.startsWith('/') || rest === '' ? { path: rest, query: new URLSearchParams(), hash } : { path: '', query: new URLSearchParams(rest), hash }
}

const joined = (path: string, query: URLSearchParams, hash = ''): string => {
  const text = query.toString()
  return `${path}${text ? `?${text}` : ''}${hash}`
}

const searchOf = (search: Search): string => (search === null || search === undefined ? '' : String(search))

/** The `thread=` value of an address or search, or null (none, or empty). */
export function threadTermOf(search: Search): string | null {
  const value = partsOf(searchOf(search)).query.get(THREAD_TERM)
  return value ? value : null
}

/** A dock scope (`general`, `project:<id>`, `wo:<id>`, `all`): any value but the narrow view's `open` and the arrival's `new`. */
export function scopeTermOf(value: string | null | undefined): string | null {
  return value && value !== 'open' && value !== 'new' ? value : null
}

/**
 * The address with `thread=` set to `value` (null: dropped) and `message=` set to `options.message` (absent or null: dropped — a
 * move leaves the message it was at); every other term and the hash kept. Takes an address (`/w/…/orders/o1?tab=lines#x`) or a
 * search (`?tab=lines`) and gives the same shape back.
 */
export function withThread(address: string, value: string | null, options: { readonly message?: string | null } = {}): string {
  const { path, query, hash } = partsOf(address)
  if (value) query.set(THREAD_TERM, value)
  else query.delete(THREAD_TERM)
  if (options.message) query.set(MESSAGE_TERM, options.message)
  else query.delete(MESSAGE_TERM)
  return joined(path, query, hash)
}

/**
 * The link of one of the record's tabs (`<base>?tab=<tab>`), keeping only the dock's scope: a tab link never carries the narrow
 * view's `open`, an arrival's `new`, a message or any other term of the page now (as before, a tab link starts the tab clean).
 */
export function tabHref(base: string, tab: string, search: Search): string {
  const query = new URLSearchParams()
  query.set('tab', tab)
  const scope = scopeTermOf(threadTermOf(search))
  if (scope) query.set(THREAD_TERM, scope)
  return joined(base, query)
}

/**
 * An in-page move to a tab (Amend → Lines, Show on the page, Still to do): `tab` set, every other term kept, the dock's scope kept,
 * `open` / `new` / `message=` dropped; below 1280 px (`narrow`) the term goes (the page gives way: the frame keeps the scope).
 * `arrival`: an old tab's landing (`?tab=dates` → Production #dates) renames the tab and keeps every term as it came — `new`, `open`
 * and `message=` are still the frame's and the thread's to read. `anchor` names the section to scroll to (`#still-to-do`).
 */
export function tabAddress(pathname: string, search: Search, tab: string, options: { readonly narrow?: boolean; readonly anchor?: string | null; readonly arrival?: boolean } = {}): string {
  const { query } = partsOf(searchOf(search))
  query.set('tab', tab)
  if (options.arrival) return joined(pathname, query, options.anchor ? `#${options.anchor}` : '')
  const scope = options.narrow ? null : scopeTermOf(query.get(THREAD_TERM))
  if (scope) query.set(THREAD_TERM, scope)
  else query.delete(THREAD_TERM)
  query.delete(MESSAGE_TERM)
  return joined(pathname, query, options.anchor ? `#${options.anchor}` : '')
}

/**
 * The scope the frame keeps for its narrow view (this page mount only): a scope in the address is kept; `open` is This order's own
 * (nothing kept); no term docked is This order too; no term below 1280 px is the view closed — the scope stays kept, so the band's
 * Thread button opens the view on it again (11-dock §4: the scope survives a close and a tab change there too).
 */
export function keptScopeOf(kept: string | null, term: string | null, mode: 'docked' | 'stacked'): string | null {
  const scope = scopeTermOf(term)
  if (scope) return scope
  if (term === 'open') return null
  if (term === 'new') return kept
  return mode === 'docked' ? null : kept
}

/** What `writeSearch` reads and writes: the window, or a stand-in in a test. */
export interface HistoryTarget {
  readonly location: { readonly pathname: string; readonly search: string; readonly hash: string }
  readonly history: { replaceState(data: unknown, unused: string, url?: string | null): void; pushState(data: unknown, unused: string, url?: string | null): void }
}

const windowTarget = (): HistoryTarget | null => (typeof window === 'undefined' ? null : window)

/** The address now: path, terms and hash. */
export function currentAddress(target: HistoryTarget | null = windowTarget()): string {
  if (!target) return ''
  return `${target.location.pathname}${target.location.search}${target.location.hash}`
}

/**
 * THE history writer of the record pages (the frame's `setThread`, the customer page's `dock=`): writes `next` (a path with its
 * terms; the hash now is kept when `next` names none) only when it differs from the address now — a replace, or a push when asked
 * (the narrow full-width view opening). Returns whether it wrote.
 */
export function writeSearch(next: string, options: { readonly push?: boolean } = {}, target: HistoryTarget | null = windowTarget()): boolean {
  if (!target) return false
  const address = next.includes('#') ? next : `${next}${target.location.hash}`
  if (address === currentAddress(target)) return false
  if (options.push) target.history.pushState(null, '', address)
  else target.history.replaceState(null, '', address)
  return true
}

/** Below 1280 px now (the frame's stacked mode): for a page's own in-page moves, which run outside the frame. */
export function narrowNow(): boolean {
  return typeof window !== 'undefined' && !window.matchMedia(`(min-width: ${DOCK_FROM}px)`).matches
}
