/**
 * Whether a DS surface opened from `el` (a modal, a menu, a cell editor that renders at `document.body`) should
 * draw itself dark.
 *
 * A `.dark` ancestor alone is not enough. `.dark` sits on <html> whenever the theme is dark — including a dark OS
 * with the theme on "system" — but a light-pinned section stays light under it. A surface opened from inside such a
 * section must stay light too; before this it copied `.dark` from <html> and opened as a dark popup on a light page
 * (2026-10-11, the Negative Targeting record modal on a dark Mac).
 *
 * The computed `color-scheme` cannot tell: AG Grid's theme sets `color-scheme: dark` on its own subtree under a dark
 * theme, even inside a light-pinned page. So the light-pinned sections are named here — the SAME list as the token pin
 * in `app/_shared/shared-shell.css` (`body:has(.h10-shell), .h10-shell, :where(.fleet-surface, .fleet-portal)`).
 * A new light-pinned section adds its selector in both places, or carries `data-nds-light`.
 */
export const LIGHT_PINNED = '.h10-shell, .fleet-surface, .fleet-portal, [data-nds-light]'

/**
 * The body's own pin (`body:has(.h10-shell)` in the shared shell): a surface opened while nothing inside the page holds
 * the focus — a deep link or a reload opens a modal with the focus on <body> — follows it, as its portals do. Before
 * this such a modal opened dark on a light page (2026-10-11, the Negative Targeting rule detail on a dark Mac).
 */
export const BODY_PINNED_BY = '.h10-shell'

export function opensDark(el: Element | null | undefined): boolean {
  if (!el || !el.closest('.dark')) return false
  if (el.closest(LIGHT_PINNED)) return false
  const doc = el.ownerDocument
  if (doc && (el === doc.body || el === doc.documentElement) && doc.body?.querySelector(BODY_PINNED_BY)) return false
  return true
}
