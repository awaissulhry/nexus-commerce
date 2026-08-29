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
 * The search field is 36px tall; `sm` buttons are 28. Without a floor the toolbar dropped 8px on the
 * first tick and rose again on Clear — measured on /products/next, then again in the lab when the
 * rule lived only in the page's stylesheet. It lives here now (`.nds-grid-selbar`, `min-height: 36px`,
 * `flex-wrap: nowrap`). The cluster never wraps: the card is a size container (`GridCard`), and under
 * 1320px the button LABELS hide (`SelectionLabel`), under 1100px the reach note hides
 * (`SelectionNote`) — a narrow button beats a second line.
 */
import { memo, type ReactNode } from 'react'

export const GridSelectionActions = memo(function GridSelectionActions({ children }: { children: ReactNode }) {
  return <span className="nds-grid-selbar">{children}</span>
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
