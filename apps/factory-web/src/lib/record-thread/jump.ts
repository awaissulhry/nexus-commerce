import { centreInList } from './parts/scroll'

/**
 * pt-w1 W1.4 (lane pt-, S5; ONE SHARED THREAD): the jump both doors run — to the message a quote, a correction or a pin names (the
 * office also: a search hit, an ask, the file viewer). Moved out of the office host as it was (tw- W1.4, 13-backend §1.3; Z10, B10):
 * older pages of the API's most (JUMP_PAGE) are read until the message is there, at most JUMP_LIMIT older messages, and the host
 * applies them in ONE render; not reached, the words say why (a page could not be read; too far back; out of the reader's reach).
 * Then the row is centred in its LIST — never the page — and focused; the host lights it (its flash). The host hands its own page
 * read: no API, no session here.
 */

/** tw- W1.4 (13-backend §1.3): a jump reads older pages of the API's most (200), one render at the end … */
export const JUMP_PAGE = 200
/** … up to this many older messages; further: "Too far back to open here." (B10). */
export const JUMP_LIMIT = 1000

/** What a jump read: the older messages (the host applies them in ONE render), the cursor after them, whether it got there. */
export interface PageBack<M> {
  readonly read: M[]
  readonly cursor: string | null
  readonly found: boolean
  /** An older page could not be read. */
  readonly failed: boolean
  /** How many pages were read (none: nothing to apply). */
  readonly pages: number
}

/** What a jump asks for: the message, whether the host has it loaded, its older pages' read, a page's size and the limit. */
export interface PageBackAsk<M> {
  readonly id: string
  readonly has: (messageId: string) => boolean
  readonly cursor: string | null
  readonly readPage: (cursor: string, size: number) => Promise<{ readonly messages: readonly M[]; readonly nextCursor: string | null }>
  readonly page: number
  readonly limit: number
}

/**
 * Older pages read until the message `id` is there: `has` says whether the host has it loaded already; `readPage` reads the page after
 * a cursor (`size` messages); at most `limit` older messages (`page` a page). Stops at the first page that fails.
 */
export async function pageBack<M extends { readonly id: string }>({ id, has, cursor: from, readPage, page, limit }: PageBackAsk<M>): Promise<PageBack<M>> {
  const read: M[] = []
  const there = () => has(id) || read.some((message) => message.id === id)
  let cursor = from
  let failed = false
  let pages = 0
  while (!there() && cursor && pages * page < limit) {
    try {
      const next = await readPage(cursor, page)
      cursor = next.nextCursor
      read.push(...next.messages)
    } catch {
      failed = true
      break
    }
    pages += 1
  }
  return { read, cursor, found: there(), failed, pages }
}

/**
 * pt-fx1 R-1: the jump's pages — or, when the message is loaded already, what it found AT ONCE (no promise, so the host lights the row
 * in the same turn). A caller's own work scheduled right after the jump then still comes last: the office's Answer door puts the focus
 * in the box after the jump lit (and focused) its row, as before the jump moved here (an `await` always yields, and the row's focus
 * then came after the box's).
 */
export function pageBackOrNow<M extends { readonly id: string }>(ask: PageBackAsk<M>): PageBack<M> | Promise<PageBack<M>> {
  if (ask.has(ask.id)) return { read: [], cursor: ask.cursor, found: true, failed: false, pages: 0 }
  return pageBack(ask)
}

/**
 * Why a jump (a quote, a correction, a pin, a search hit, an ask, the file viewer) did not reach its message, in words (null: it is
 * there): an older page could not be read; the 1,000 messages a jump reads ran out with more left ("Too far back to open here."); or
 * the thread has no such message for this reader ("That message is out of your reach.").
 */
export function jumpRefusal(outcome: { readonly found: boolean; readonly failed: boolean; readonly cursor: string | null }): { readonly ns: string; readonly key: string } | null {
  if (outcome.found) return null
  if (outcome.failed) return { ns: 'record-thread-feed', key: 'older.failed' }
  if (outcome.cursor !== null) return { ns: 'record-thread', key: 'notice.messageGone' }
  return { ns: 'record-thread', key: 'notice.outOfReach' }
}

/** The found row: centred in its list (never the page, tw- fx2 G-3) and focused, at once (rows may still arrive). */
export function lightRow(messageId: string): void {
  const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
  centreInList(target) // tw- fx2 (G-3): the list scrolls, never the page
  target?.focus({ preventScroll: true })
}
