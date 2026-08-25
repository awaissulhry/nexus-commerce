'use client'

import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'

export interface MenuItemDef {
  id: string
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  onSelect?: () => void
}

export interface MenuProps {
  /** trigger button content */
  label: ReactNode
  items: MenuItemDef[]
  align?: 'left' | 'right'
  triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>
  className?: string
}

/**
 * Anchored dropdown menu (H10 `.h10-menu` look). The trigger renders as a DS
 * secondary button; the menu closes on outside-click or item select. Requires
 * `styles/primitives.css` (trigger) + `styles/components.css` (menu).
 */
export function Menu({ label, items, align = 'left', triggerProps, className }: MenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // A menu sizes to its own content, not to a trigger that may be a 28px icon button.
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, {
    width: 'auto',
    align: align === 'right' ? 'end' : 'start',
  })
  // Was a hand-rolled copy of useClickAway. It had to go anyway: the panel now portals, so a
  // single-ref check treats clicking a menu item as an outside click.
  useClickAway([ref, popRef], () => setOpen(false), open)

  return (
    <div className={`nds-menu-wrap${className ? ` ${className}` : ''}`} ref={ref}>
      <button type="button" className="nds-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} {...triggerProps}>
        {label}
      </button>
      {open && (
        createPortal(
          <div ref={popRef} style={popStyle} className="nds-menu" role="menu">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  it.onSelect?.()
                  setOpen(false)
                }}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
