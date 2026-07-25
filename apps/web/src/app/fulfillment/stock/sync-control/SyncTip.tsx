'use client'

/**
 * SCT.1 — one wrapper for every tooltipped control on the Sync Control
 * surfaces.
 *
 * `Tooltip` clones its child to inject a ref plus mouse/focus handlers, so the
 * child MUST be a real DOM node: DS function components (Button, Listbox,
 * MultiSelect, SegmentedControl, Pill) drop the injected props and the tooltip
 * silently never fires. `Tip` supplies that DOM node.
 *
 * Every action button on this page moves live marketplace quantity, so the help
 * text is deliberately long — it says what is written, what is NOT touched, and
 * how to undo it. See ACTION_HELP / CONTROL_HELP in sync-control-shared.ts.
 */

import type { CSSProperties, ReactNode } from 'react'
import { Tooltip } from '@/components/ui/Tooltip'

export function Tip({
  help,
  children,
  width,
  style,
  placement,
}: {
  help: ReactNode
  children: ReactNode
  /** Fixed width for wrapped Listbox/MultiSelect (they need a sized parent). */
  width?: number
  style?: CSSProperties
  placement?: 'top' | 'bottom' | 'left' | 'right'
}) {
  if (!help) return <>{children}</>
  return (
    <Tooltip content={help} placement={placement}>
      <span className="inline-flex" style={{ width, ...style }}>
        {children}
      </span>
    </Tooltip>
  )
}

/** Help cursor variant, for labels/headers/chips rather than clickable controls.
 *  `cursor="inherit"` keeps a SORTABLE column header's pointer cue. */
export function TipText({
  help,
  children,
  cursor = 'help',
}: {
  help: ReactNode
  children: ReactNode
  cursor?: CSSProperties['cursor']
}) {
  if (!help) return <>{children}</>
  return (
    <Tooltip content={help}>
      <span className="inline-flex" style={{ cursor }}>
        {children}
      </span>
    </Tooltip>
  )
}
