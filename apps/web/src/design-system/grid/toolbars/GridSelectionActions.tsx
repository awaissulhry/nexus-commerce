'use client'

/**
 * GDS — the toolbar's two halves that SWAP when rows are selected, and the rule that keeps the
 * toolbar the same height while they do.
 *
 *   <GridToolbar count={…}>
 *     {selected ? (
 *       <GridSelectionActions>
 *         <Button size="sm" variant="primary"><Icon /> <SelectionLabel>Bulk edit</SelectionLabel></Button>
 *         …
 *         <Button size="sm" variant="link" onClick={clear}>Clear</Button>
 *       </GridSelectionActions>
 *     ) : (
 *       <GridSearchSlot><Input leadingIcon={<Search />} placeholder="Search…" /></GridSearchSlot>
 *     )}
 *   </GridToolbar>
 *
 * The search field and `sm` buttons are both 28 (the toolbar tier; it was 36 before 2026-10-11). Without a floor the toolbar dropped 8px on the
 * first tick and rose again on Clear — measured on /products/next, then again in the lab when the
 * rule lived only in the page's stylesheet. It lives here now (`.nds-grid-selbar`, `min-height` = the slot height,
 * `flex-wrap: nowrap`). The cluster never wraps: when it does not fit on its line, the reach note hides first
 * (`SelectionNote`), then the button LABELS (`SelectionLabel`) — a narrow button beats a second line.
 *
 * MEASURED, not a fixed card width (Keyword Harvest audit S1, 2026-10-11). It was `@container (max-width: 1320px)`:
 * a 1312 px card showed icons only with 600 px of the bar empty, and the counts on the buttons ("Harvest 54") never
 * showed. Now the cluster tries the full form, then without the note, then icons — before paint, on every render
 * and whenever the toolbar's width changes — and keeps the first form that fits (`selectionBarFit`).
 */
import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

/** The forms the cluster can take, fullest first: `data-fit` on `.nds-grid-selbar` (grid.css hides by it). */
export const SELECTION_BAR_FITS = ['', 'no-note', 'no-note icons'] as const
export type SelectionBarFit = (typeof SELECTION_BAR_FITS)[number]

/** The first form that does not overflow; the last one when none fits (icons, wrapping as the host allows). Pure. */
export function selectionBarFit(overflowsAs: (fit: SelectionBarFit) => boolean): SelectionBarFit {
  for (const fit of SELECTION_BAR_FITS) if (!overflowsAs(fit)) return fit
  return SELECTION_BAR_FITS[SELECTION_BAR_FITS.length - 1]
}

/**
 * Apply the fit to a cluster in the page. While it measures, the cluster is held on one line (`data-measure`): a phone
 * card lets it wrap onto lines of its own (grid.css), and "fits" means fits on ONE line there too.
 */
export function fitSelectionBar(el: HTMLElement | null): void {
  if (!el) return
  const bar = el.parentElement
  el.setAttribute('data-measure', '')
  const fit = selectionBarFit((form) => {
    el.setAttribute('data-fit', form)
    return el.scrollWidth > el.clientWidth + 1 || (!!bar && bar.scrollWidth > bar.clientWidth + 1)
  })
  el.setAttribute('data-fit', fit)
  el.removeAttribute('data-measure')
}

export const GridSelectionActions = memo(function GridSelectionActions({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  // Before paint, whenever the buttons change (a count, a held verb): no frame shows the wrong form.
  useLayoutEffect(() => { fitSelectionBar(ref.current) })
  // And when the toolbar's width changes (a resize, a side panel).
  useEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fitSelectionBar(el))
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  return <span ref={ref} className="nds-grid-selbar">{children}</span>
})

/** A button's text, hidden on a narrow card so the icon-only button keeps the row on one line. */
export const SelectionLabel = memo(function SelectionLabel({ children }: { children: ReactNode }) {
  return <span className="nds-grid-selbar-lbl">{children}</span>
})

/** The muted "also reaches N variations" note beside the count; hidden first when space runs out. */
export const SelectionNote = memo(function SelectionNote({ children }: { children: ReactNode }) {
  return <span className="nds-grid-selbar-note">{children}</span>
})

/** The search field's slot in the toolbar: grows to 340px, never below 220px. */
export const GridSearchSlot = memo(function GridSearchSlot({ children }: { children: ReactNode }) {
  return <span className="nds-grid-search">{children}</span>
})
