'use client'

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

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

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className={`h10-ds-menu-wrap${className ? ` ${className}` : ''}`} ref={ref}>
      <button type="button" className="h10-ds-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} {...triggerProps}>
        {label}
      </button>
      {open && (
        <div className={['h10-ds-menu', align === 'right' ? 'right' : ''].filter(Boolean).join(' ')} role="menu">
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
        </div>
      )}
    </div>
  )
}
