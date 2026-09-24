/**
 * A-45 (Step 4.3 #4) — a LOCKED column whose cell holds a detail trigger (`DetailPopover`) opens it with
 * Enter or Space, so the detail is reachable without a pointer.
 *
 * Use it as the column's `suppressKeyboardEvent`. Returning `true` tells AG to leave the event alone:
 *  - focus is ON the trigger button → the button's own Enter / Space (native), AG must not consume it;
 *  - focus is on the CELL, the key is Enter or Space, the cell is not editing → click the cell's trigger;
 *  - anything else → `false`: AG keeps arrows, Tab, copy and every other key.
 *
 * Only for columns that are NOT editable: on an editable column Enter belongs to the editor (A-42's one
 * keyboard model), and this must never compete with it.
 */
export const CELL_DETAIL_TRIGGER = '[data-cell-detail-trigger]'

export interface CellDetailKeyParams {
  event: { key: string; type?: string; target: EventTarget | null; preventDefault?: () => void }
  editing: boolean
}

export function cellDetailKeys({ event, editing }: CellDetailKeyParams): boolean {
  const target = event.target as (Element & { closest?: Element['closest']; querySelector?: Element['querySelector'] }) | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(CELL_DETAIL_TRIGGER)) return true
  if (editing || (event.key !== 'Enter' && event.key !== ' ')) return false
  const trigger = typeof target.querySelector === 'function' ? target.querySelector<HTMLElement>(CELL_DETAIL_TRIGGER) : null
  if (!trigger) return false
  // AG calls this for keydown AND keypress; act once.
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  trigger.click()
  return true
}
