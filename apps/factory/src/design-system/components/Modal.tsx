'use client'

import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { Size } from '../primitives/size'

// Shared stack keeps background content out of keyboard and assistive-technology navigation.
const modalStack: HTMLElement[] = []
const previousInert = new Map<HTMLElement, boolean>()
function updateModalBackground() {
  const top = modalStack[modalStack.length - 1]
  if (!top) {
    for (const [element, inert] of previousInert) element.inert = inert
    previousInert.clear()
    return
  }
  for (const element of Array.from(document.body.children)) {
    if (!(element instanceof HTMLElement)) continue
    if (!previousInert.has(element)) previousInert.set(element, element.inert)
    element.inert = element !== top
  }
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  /** footer slot, right-aligned (e.g. Cancel / Save buttons).
   *  A `<span className="grow" />` between children splits it: left group / right group. */
  footer?: ReactNode
  /**
   * 440 (sm) / 560 (md) / 660 (lg) / 920 (xl) / 1040 (xxl, for table modals) /
   * `full` (a MEDIA surface: `min(1680px, 96vw)` × 94vh).
   *
   * `full` exists because the DS had no surface for inspecting a picture. A product photo is
   * checked for framing, background and text overlay at something near its own size, and `xxl`
   * caps at 1040px × 82vh — a 2250×2250 image arrives there smaller than the tile it was opened
   * from. Added by PES.7 for the Product Edit Studio's image viewer; additive, so every existing
   * consumer renders byte-for-byte as before.
   */
  size?: Size | 'xxl' | 'full'
  children?: ReactNode
  /** Stronger text contrast and focus for editing; preserves each control’s Nexus size. */
  readable?: boolean
  className?: string
  /** Optional grid-cell anchor. On narrow screens uses the usual modal layout and focus contract. */
  anchor?: HTMLElement | null
  /** accessible name when there is no visible `title` (a titled modal names itself) */
  'aria-label'?: string
}

/**
 * Centered modal (H10 `.h10-modal` spec). Portaled to <body>; Esc + backdrop
 * click close; scrollable body between bordered header/footer.
 */
export function Modal({ open, onClose, title, subtitle, footer, size = 'sm', children, readable = false, className, anchor, 'aria-label': ariaLabel }: ModalProps) {
  const titleId = useId()
  const subtitleId = useId()
  const modalRef = useRef<HTMLDivElement>(null)
  const [anchoredStyle, setAnchoredStyle] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!open || !anchor) { setAnchoredStyle(undefined); return }
    const place = () => {
      const dialog = modalRef.current
      if (!dialog || !anchor.isConnected || window.innerWidth < 640) { setAnchoredStyle(undefined); return }
      const a = anchor.getBoundingClientRect(), d = dialog.getBoundingClientRect(), pad = 8
      const left = Math.max(pad, Math.min(a.left, window.innerWidth - d.width - pad))
      const below = a.bottom + pad, above = a.top - d.height - pad
      const top = Math.max(pad, Math.min(below + d.height <= window.innerHeight - pad ? below : above >= pad ? above : pad, window.innerHeight - d.height - pad))
      setAnchoredStyle({ position: 'fixed', left, top })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place); if (modalRef.current) observer.observe(modalRef.current)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, anchor])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const wasOpen = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null
  wasOpen.current = open
  const dark = !!opener.current?.closest('.dark')
  useEffect(() => {
    if (!open) return
    const dialog = modalRef.current
    const previous = opener.current
    const backdrop = dialog?.parentElement
    if (backdrop) { modalStack.push(backdrop); updateModalBackground() }
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]') ?? [])
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0)
    if (dialog && !dialog.contains(document.activeElement)) (focusable().find(element => element.matches('[data-autofocus], [autofocus]')) ?? focusable()[0] ?? dialog).focus()
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]')
      if (dialogs[dialogs.length - 1] !== dialog || event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0] ?? dialog
      const last = elements[elements.length - 1] ?? dialog
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (backdrop) { const index = modalStack.indexOf(backdrop); if (index >= 0) modalStack.splice(index, 1); updateModalBackground() }
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus()
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="nds-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        style={anchoredStyle}
        tabIndex={-1}
        className={['nds-modal', readable ? 'nds-readable' : '', dark ? 'dark' : '', size === 'sm' ? '' : size, className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-describedby={subtitle != null ? subtitleId : undefined}
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nds-modal-h">
          <div>
            {title != null && <div className="t" id={titleId}>{title}</div>}
            {subtitle != null && <div className="sub" id={subtitleId}>{subtitle}</div>}
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
