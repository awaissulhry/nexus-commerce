'use client'

/**
 * The disclosure chevron a row owns: expand/collapse a product family, a row group, a tree node.
 *
 * It exists because the grid needs a control the toolbar button cannot be. `ToolbarButton` is
 * 28×28 with its own pressed styling keyed off `[aria-expanded]`; a row expander is 20×20, sits
 * inside a cell beside a thumbnail whose offset is measured to the pixel, and must not paint a
 * filled background merely because its row is open. Same reason `FilterChip` is not `Button`.
 *
 * `aria-expanded` is not optional here — it is the whole semantic. The label says what the click
 * DOES ("Expand variations"), because a screen reader already announces the expanded state.
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'

export interface ExpandToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'aria-expanded'> {
  expanded: boolean
  /** Accessible name — what the click does, not what the state is. */
  label: string
  /** Chevron size in px. The 20×20 hit area does not change with it. */
  size?: number
}

export function ExpandToggle({ expanded, label, size = 14, className, ...rest }: ExpandToggleProps) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      className={['nds-expand', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {expanded ? <ChevronDown size={size} /> : <ChevronRight size={size} />}
    </button>
  )
}
