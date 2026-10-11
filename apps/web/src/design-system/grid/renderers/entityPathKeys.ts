/**
 * The keys of `entityPathColumn` (Keyword Harvest DS lane H7, 2026-10-10) — its `suppressKeyboardEvent`.
 *
 * A path holds up to three links (portfolio › campaign › ad group), and a grid cell is ONE Tab stop, so the cell lets the
 * keyboard in and out:
 *   - on the cell: Enter follows the only link; with several it puts the focus on the LAST one (the most precise place);
 *   - on a link: ← / → move between the path's links, Enter is the link's own (it navigates), Esc gives the focus back
 *     to the cell. Tab stays AG's (on to the next cell); every other key is the link's.
 * Arrows on the cell, Tab, copy and every other key stay AG's.
 */
import type { CellDetailKeyParams } from '../cellDetail'

type Node = Element & { closest?: Element['closest']; querySelectorAll?: Element['querySelectorAll'] }

export function entityPathKeys({ event, editing }: CellDetailKeyParams): boolean {
  const target = event.target as Node | null
  if (!target || typeof target.closest !== 'function') return false
  const onLink = target.closest('a[href]')
  if (onLink) {
    if (event.key === 'Tab') return false
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Escape') return true
    const cell = target.closest('.ag-cell') as (HTMLElement & Node) | null
    // AG calls this for keydown AND keypress; act once.
    if (event.type && event.type !== 'keydown') return true
    event.preventDefault?.()
    if (event.key === 'Escape') { cell?.focus(); return true }
    const links = cell && typeof cell.querySelectorAll === 'function' ? Array.from(cell.querySelectorAll<HTMLElement>('a[href]')) : []
    const at = links.indexOf(onLink as HTMLElement)
    links[event.key === 'ArrowLeft' ? Math.max(0, at - 1) : Math.min(links.length - 1, at + 1)]?.focus()
    return true
  }
  if (editing || event.key !== 'Enter') return false
  const links = typeof target.querySelectorAll === 'function' ? Array.from(target.querySelectorAll<HTMLElement>('a[href]')) : []
  if (!links.length) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  if (links.length === 1) links[0].click()
  else links[links.length - 1].focus()
  return true
}
