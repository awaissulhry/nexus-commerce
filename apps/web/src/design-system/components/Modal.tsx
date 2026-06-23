'use client'

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  /** footer slot, right-aligned (e.g. Cancel / Save buttons) */
  footer?: ReactNode
  /** 440 / 560 / 660 / 920 px (H10 modal widths) */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  children?: ReactNode
}

/**
 * Centered modal (H10 `.h10-modal` spec). Portaled to <body>; Esc + backdrop
 * click close; scrollable body between bordered header/footer.
 */
export function Modal({ open, onClose, title, subtitle, footer, size = 'sm', children }: ModalProps) {
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
    <div className="h10-ds-backdrop" onClick={onClose}>
      <div
        className={['h10-ds-modal', size === 'md' ? 'md' : size === 'lg' ? 'lg' : size === 'xl' ? 'xl' : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h10-ds-modal-h">
          <div>
            {title != null && <div className="t">{title}</div>}
            {subtitle != null && <div className="sub">{subtitle}</div>}
          </div>
          <button type="button" className="h10-ds-modal-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="h10-ds-modal-b">{children}</div>
        {footer != null && <div className="h10-ds-modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
