'use client'

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  footer?: ReactNode
  children?: ReactNode
}

/** Right-side slide-over panel. Portaled to <body>; Esc + backdrop close. */
export function Drawer({ open, onClose, title, footer, children }: DrawerProps) {
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
      <div className="h10-ds-drawer" role="dialog" aria-modal="true">
        <div className="h10-ds-drawer-h">
          <span className="t">{title}</span>
          <button type="button" className="h10-ds-modal-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="h10-ds-drawer-b">{children}</div>
        {footer != null && <div className="h10-ds-drawer-f">{footer}</div>}
      </div>
    </>,
    document.body,
  )
}
