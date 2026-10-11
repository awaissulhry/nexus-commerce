/**
 * The keys of `entityLinksColumn` (bid page DS lane, 2026-10-10) — its `suppressKeyboardEvent`.
 *
 * A focused cell answers Enter without a pointer: several things → the count opens its list (the same rule as a
 * locked column's detail, `cellDetailKeys`: Enter or Space); one thing → Enter follows its link, as a click would.
 * Focus ON the count or ON a link keeps the control's own keys. Arrows, Tab, copy and every other key stay AG's.
 */
import { cellDetailKeys, type CellDetailKeyParams } from '../cellDetail'

export function entityLinksKeys({ event, editing }: CellDetailKeyParams): boolean {
  if (cellDetailKeys({ event, editing })) return true
  const target = event.target as (Element & { closest?: Element['closest']; querySelector?: Element['querySelector'] }) | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest('a[href]')) return true
  if (editing || event.key !== 'Enter') return false
  const link = typeof target.querySelector === 'function' ? target.querySelector<HTMLElement>('a[href]') : null
  if (!link) return false
  // AG calls this for keydown AND keypress; act once.
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  link.click()
  return true
}
