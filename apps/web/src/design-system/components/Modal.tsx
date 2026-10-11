'use client'

import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { Size } from '../primitives/size'
import { createLayerStack, ownsKeys, returnFocusOrder, type ReturnFocusTarget } from './modalStack'
import { opensDark } from '../lib/opens-dark'

// Shared stack keeps background content out of keyboard and assistive-technology navigation. Bottom first: the last
// dialog opened is on top, answers Esc and Tab, and everything else — the dialogs under it too — is inert (modalStack.ts).
const modalStack = createLayerStack<HTMLElement>()
const previousInert = new Map<HTMLElement, boolean>()
function updateModalBackground() {
  const top = modalStack.top()
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

/** True when `dialog` is the dialog of the Modal on top of the shared stack (a review stacked over a detail is; the detail under it is not). */
export function isTopModal(dialog: Element | null | undefined): boolean {
  const backdrop = dialog?.parentElement
  return !!backdrop && modalStack.isTop(backdrop)
}

/** Another kind of modal surface (a Drawer, a Builder) that comes after this dialog in the page, or inside it, covers it. */
function coveredByOther(dialog: HTMLElement): boolean {
  for (const other of Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))) {
    if (other === dialog) continue
    // Another Modal: the stack decides, not where its portal sits in the page.
    if (other.parentElement && modalStack.has(other.parentElement)) continue
    if (dialog.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return true
  }
  return false
}

/** Focus it if it can take focus now (in the page, not inert or hidden); true when the focus really landed there. */
function focusIfAble(element: HTMLElement): boolean {
  if (!element.isConnected || element === document.body || element.closest('[inert], [hidden]')) return false
  element.focus()
  return document.activeElement === element
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
   * `full` (a MEDIA surface: `min(1680px, 96vw)` × 94vh) /
   * `detail` (a row's detail: 1160px wide, the viewport's height less a margin and at most 880px, so Prev / Next and
   * the tabs never make it jump; header and `subheader` stay, the body scrolls; a full-screen sheet on a phone).
   *
   * `full` exists because the DS had no surface for inspecting a picture. A product photo is
   * checked for framing, background and text overlay at something near its own size, and `xxl`
   * caps at 1040px × 82vh — a 2250×2250 image arrives there smaller than the tile it was opened
   * from. Added by PES.7 for the Product Edit Studio's image viewer; additive, so every existing
   * consumer renders byte-for-byte as before.
   */
  size?: Size | 'xxl' | 'full' | 'detail'
  children?: ReactNode
  /** Stronger text contrast and focus for editing; preserves each control’s Nexus size. */
  readable?: boolean
  className?: string
  /** Optional grid-cell anchor. On narrow screens uses the usual modal layout and focus contract. */
  anchor?: HTMLElement | null
  /** accessible name when there is no visible `title` (a titled modal names itself) */
  'aria-label'?: string
  /**
   * Where the focus goes when the dialog closes. Default: the element that had it when the dialog opened; when that
   * one is gone (a re-rendered grid cell, a button the save removed), the dialog now on top — a review closing over a
   * detail lands back inside the detail. A function is read at close time: name a cell that may have been re-rendered,
   * or the row Prev / Next moved to. If the host moved the focus itself while closing, it stays where the host put it.
   */
  returnFocusTo?: ReturnFocusTarget<HTMLElement>
  /** Controls in the header row, before Close (a detail's actions and Prev / Next). */
  headerActions?: ReactNode
  /** A row fixed under the header that does not scroll with the body (a detail's tabs). */
  subheader?: ReactNode
  /** What takes the focus on open: the first control (default), or the dialog itself — its title is read first and the
   *  host's keys work at once (a detail, whose first control would be a Prev button). `[data-autofocus]` wins either way. */
  initialFocus?: 'first' | 'dialog'
  /** The body is being read (`aria-busy`). */
  busy?: boolean
}

/**
 * Centered modal (H10 `.h10-modal` spec). Portaled to <body>; Esc + backdrop
 * click close; scrollable body between bordered header/footer. Modals stack: a second one opens above the first,
 * Esc closes only the top one, and the focus goes back to the opener — also when the opener is inside the modal below.
 */
export function Modal({
  open, onClose, title, subtitle, footer, size = 'sm', children, readable = false, className, anchor, 'aria-label': ariaLabel,
  returnFocusTo, headerActions, subheader, initialFocus = 'first', busy = false,
}: ModalProps) {
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
  const returnFocusRef = useRef(returnFocusTo)
  returnFocusRef.current = returnFocusTo
  const initialFocusRef = useRef(initialFocus)
  initialFocusRef.current = initialFocus
  const wasOpen = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null
  wasOpen.current = open
  const dark = opensDark(opener.current)
  useEffect(() => {
    if (!open) return
    const dialog = modalRef.current
    const previous = opener.current
    const backdrop = dialog?.parentElement
    if (backdrop) { modalStack.push(backdrop); updateModalBackground() }
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]') ?? [])
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0)
    if (dialog && !dialog.contains(document.activeElement)) {
      const elements = focusable()
      const auto = elements.find(element => element.matches('[data-autofocus], [autofocus]'))
      ;(auto ?? (initialFocusRef.current === 'dialog' ? dialog : elements[0] ?? dialog)).focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (!dialog || !backdrop || !ownsKeys(modalStack, backdrop, { coveredByOther: coveredByOther(dialog), handled: event.defaultPrevented })) return
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
      if (backdrop) { modalStack.remove(backdrop); updateModalBackground() }
      // The host put the focus somewhere on purpose while this closed (outside this dialog, not <body>): leave it.
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body && active.isConnected && !dialog?.contains(active)) return
      const below = modalStack.top()?.querySelector<HTMLElement>(':scope > [role="dialog"]') ?? null
      for (const target of returnFocusOrder({ override: returnFocusRef.current, opener: previous, below })) if (focusIfAble(target)) break
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className={size === 'detail' ? 'nds-backdrop detail' : 'nds-backdrop'} onClick={onClose}>
      <div
        ref={modalRef}
        style={anchoredStyle}
        tabIndex={-1}
        className={['nds-modal', readable ? 'nds-readable' : '', dark ? 'dark' : '', size === 'sm' ? '' : size, className ?? ''].filter(Boolean).join(' ')}
        // A light modal is a light place: a modal, menu or editor opened from inside it stays light too (lib/opens-dark).
        data-nds-light={dark ? undefined : ''}
        role="dialog"
        aria-modal="true"
        aria-describedby={subtitle != null ? subtitleId : undefined}
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nds-modal-h">
          <div className="nds-modal-hl">
            {title != null && <div className="t" id={titleId}>{title}</div>}
            {subtitle != null && <div className="sub" id={subtitleId}>{subtitle}</div>}
          </div>
          {headerActions != null && <div className="nds-modal-h-actions">{headerActions}</div>}
          <button type="button" className="nds-modal-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {subheader != null && <div className="nds-modal-sh">{subheader}</div>}
        <div className="nds-modal-b" aria-busy={busy || undefined}>{children}</div>
        {footer != null && <div className="nds-modal-f">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
