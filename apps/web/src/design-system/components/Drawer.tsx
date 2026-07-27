'use client'

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  /** EFX P6 — optional smaller line under the title. */
  subtitle?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  className?: string
  /**
   * EFX P6 — panel width override. number = px, string = any CSS length.
   * Defaults to the stylesheet's 420px; the panel never exceeds the viewport
   * (max-width: 100% stays in CSS).
   */
  width?: number | string
  /**
   * A modal surface rendered INSIDE the panel, covering header, body and
   * footer. Drawers sit at z-61; the app's Modal/ConfirmDialog sits lower, so
   * a confirmation spawned from a drawer used to open BEHIND it (invisible
   * until the drawer was closed). Anything a drawer must confirm goes here
   * instead — one surface, nothing hidden, no separate pop-up.
   */
  overlay?: ReactNode
}

/** Right-side slide-over panel. Portaled to <body>; Esc + backdrop close. */
export function Drawer({ open, onClose, title, subtitle, footer, children, className, width, overlay }: DrawerProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="h10-ds-drawer-bd" onClick={onClose} />
      <div
        className={`h10-ds-drawer${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        style={width != null ? { width: typeof width === 'number' ? `${width}px` : width } : undefined}
      >
        <div className="h10-ds-drawer-h">
          <div className="h10-ds-drawer-ht">
            <span className="t">{title}</span>
            {subtitle != null && <span className="st">{subtitle}</span>}
          </div>
          <button type="button" className="h10-ds-modal-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="h10-ds-drawer-b">{children}</div>
        {footer != null && <div className="h10-ds-drawer-f">{footer}</div>}
        {overlay != null && <div className="h10-ds-drawer-ov">{overlay}</div>}
      </div>
    </>,
    document.body,
  )
}
