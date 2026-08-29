'use client'

/**
 * GDS — the strip INSIDE a grid card under an editor's grid: reason · notes · message · Cancel ·
 * Apply. Styled like the page's pager (10px 14px, a top rule), never the DS modal's own footer
 * bar — the editor IS the grid, and its actions belong to the card (IE.4).
 *
 *   <GridFooterStrip>
 *     <span>Reason</span> <Combobox … /> <Input … />
 *     <GridFooterSpacer />
 *     <Button>Cancel</Button> <Button variant="primary">Apply 3 changes</Button>
 *   </GridFooterStrip>
 */
import { memo, type ReactNode } from 'react'

export const GridFooterStrip = memo(function GridFooterStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={['nds-grid-footstrip', className].filter(Boolean).join(' ')}>{children}</div>
})

/** Pushes what follows to the right edge. */
export const GridFooterSpacer = memo(function GridFooterSpacer() {
  return <span className="nds-grid-footstrip-grow" />
})
