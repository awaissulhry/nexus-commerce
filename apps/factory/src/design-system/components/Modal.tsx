'use client'

import { useEffect, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { Size } from '../primitives/size'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  /** footer slot, right-aligned (e.g. Cancel / Save buttons).
   *  A `<span className="grow" />` between children splits it: left group / right group. */
  footer?: ReactNode
  /** 440 (sm) / 560 (md) / 660 (lg) / 920 (xl) / 1040 (xxl, for table modals) */
  size?: Size | 'xxl'
  children?: ReactNode
  className?: string
  /** accessible name when there is no visible `title` (a titled modal names itself) */
  'aria-label'?: string
}

/**
 * Centered modal (H10 `.h10-modal` spec). Portaled to <body>; Esc + backdrop
 * click close; scrollable body between bordered header/footer.
 */
export function Modal({ open, onClose, title, subtitle, footer, size = 'sm', children, className, 'aria-label': ariaLabel }: ModalProps) {
  const titleId = useId()
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
    <div className="nds-backdrop" onClick={onClose}>
      <div
        className={['nds-modal', size === 'sm' ? '' : size, className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nds-modal-h">
          <div>
            {title != null && <div className="t" id={titleId}>{title}</div>}
            {subtitle != null && <div className="sub">{subtitle}</div>}
          </div>
          <button type="button" className="nds-modal-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="nds-modal-b">{children}</div>
        {footer != null && <div className="nds-modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
