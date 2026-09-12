'use client'

import { type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { TooltipPortalProvider } from '../primitives/Tooltip'

export interface CellActionProps {
  label: string
  description?: string
  icon?: ReactNode
  onActivate(anchor: HTMLElement | null): void
  onFocusCell?(): void
}

/** A grid disclosure: one tab stop belongs to the cell; Enter/F2 opens its editor. */
export function CellAction({ label, description = 'Enter or F2 opens the editor.', icon = <Pencil size={13} />, onActivate, onFocusCell }: CellActionProps) {
  return <TooltipPortalProvider><ToolbarButton size="sm" tabIndex={-1} revealOnRowHover label={label} description={description} icon={icon}
    data-nds-cell-action
    onMouseDownCapture={event => {
      if (event.button !== 0) return
      // AG listens natively on the cell. A React bubble handler runs after range dragging starts.
      event.stopPropagation(); event.preventDefault(); onFocusCell?.()
    }}
    onDoubleClickCapture={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); onFocusCell?.(); onActivate(event.currentTarget.closest<HTMLElement>('[role="gridcell"]')) }}
  /></TooltipPortalProvider>
}
