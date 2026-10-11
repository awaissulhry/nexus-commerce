/**
 * The ad group page opened ON one row (Negative Targeting page, 2026-10-11): `?tab=targets|search-terms|
 * ad-group-negative-keywords&focus=<target id | words>`. The tab narrows its search to the row's words (the search box
 * shows them, so one click clears it), marks the row and scrolls it into view. Pure parts tested in Node
 * (`focusRow.vitest.test.ts`).
 */

/** The focused row's words: the row whose id is `focus`, else `focus` itself (a search term, a negative's words). */
export function focusText<R>(focus: string | null | undefined, rows: readonly R[], idOf: (r: R) => string, textOf: (r: R) => string): string | null {
  const f = (focus ?? '').trim()
  if (!f) return null
  const byId = rows.find((r) => idOf(r) === f)
  return byId ? textOf(byId) : f
}

/** Is this the focused row: its id, or its words (case and spacing aside)? */
export function isFocusRow(focus: string | null | undefined, id: string, text: string): boolean {
  const f = (focus ?? '').trim()
  if (!f) return false
  if (id === f) return true
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(text) === norm(f)
}

/** Scroll the first marked row into view once it is drawn (a few frames: the grid draws after its rows arrive). */
export function scrollToMarked(className: string, tries = 20): void {
  if (typeof window === 'undefined' || !className) return
  let n = 0
  const step = () => {
    const row = document.querySelector<HTMLElement>(`.${CSS.escape(className)}`)
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); return }
    if (++n < tries) window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step)
}
