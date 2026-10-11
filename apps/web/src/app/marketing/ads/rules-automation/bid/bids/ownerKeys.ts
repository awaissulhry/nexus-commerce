/**
 * Bid page, Bids view — the keys of the cells that hold links (their `suppressKeyboardEvent`). Pure, tested in Node.
 *
 * The "Campaign · Ad group" cell holds two links, one per line: Enter follows the campaign, ⇧ Enter the ad group (the
 * Rules table's works-on cells answer the same two keys). Focus ON a link keeps the link's own keys.
 *
 * The "Who sets it" cell holds up to two controls: the owner's chip — a link to its rule's detail, or for the Brain a
 * button that opens the keyword's Why tab — and "+N", the list of the other writers. A focused cell answers without a
 * pointer:
 *   Enter            → the owner's chip (or the "+N" list when the chip opens nothing)
 *   Space, ⇧ Enter   → the "+N" list
 * Focus ON a link or ON "+N" keeps the control's own keys. Arrows, Tab, copy and every other key stay AG's, and a cell
 * with neither control lets Enter through (the view opens the keyword's panel).
 */
import { CELL_DETAIL_TRIGGER } from '@/design-system/grid'

interface KeyTarget {
  closest?: (selector: string) => unknown
  querySelector?: (selector: string) => { click(): void } | null
}

export interface OwnerKeyParams {
  event: { key: string; shiftKey?: boolean; type?: string; target: unknown; preventDefault?: () => void }
  editing: boolean
}

const LINK = 'a[href]'
/** The owner's chip when it opens something: a link (a rule), or the Brain's button (the Why tab). */
export const OWNER_ACTION = 'a[href], [data-owner-action]'

export function ownerCellKeys({ event, editing }: OwnerKeyParams): boolean {
  const target = event.target as KeyTarget | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(OWNER_ACTION) || target.closest(CELL_DETAIL_TRIGGER)) return true
  if (editing) return false
  const find = (selector: string) => (typeof target.querySelector === 'function' ? target.querySelector(selector) : null)
  const link = find(OWNER_ACTION)
  const more = find(CELL_DETAIL_TRIGGER)
  const pick = event.key === 'Enter' && !event.shiftKey ? link ?? more
    : event.key === ' ' || (event.key === 'Enter' && event.shiftKey) ? more
      : null
  if (!pick) return false
  // AG calls this for keydown AND keypress; act once.
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  pick.click()
  return true
}

/** Enter → the first link (the campaign), ⇧ Enter → the second (the ad group); a focused link keeps its own keys. */
export function placeCellKeys({ event, editing }: OwnerKeyParams): boolean {
  const target = event.target as (KeyTarget & { querySelectorAll?: (selector: string) => ArrayLike<{ click(): void }> }) | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(LINK)) return true
  if (editing || event.key !== 'Enter' || typeof target.querySelectorAll !== 'function') return false
  const links = target.querySelectorAll(LINK)
  const pick = event.shiftKey ? links[1] : links[0]
  if (!pick) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  pick.click()
  return true
}

/** The row's one action button in a cell (Apply): Enter on the cell presses it; a focused button keeps its own keys. */
export const CELL_ACTION = '[data-cell-action]'
export function actionCellKeys({ event, editing }: OwnerKeyParams): boolean {
  const target = event.target as KeyTarget | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(CELL_ACTION)) return true
  if (editing || event.key !== 'Enter' || event.shiftKey) return false
  const button = typeof target.querySelector === 'function' ? target.querySelector(CELL_ACTION) : null
  if (!button) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  button.click()
  return true
}
