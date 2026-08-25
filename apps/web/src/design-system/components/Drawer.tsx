'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
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

/**
 * Right-side slide-over panel. Portaled to <body>; Esc + backdrop close.
 *
 * NAF.SB.AS-S2R / S2.e — keyboard and screen-reader access.
 *
 * Measured on production before this change: **a keyboard user needed 41 Tab
 * presses to reach an open drawer.** 63 focusable elements on the page, and
 * the first one inside the drawer was number 41 — because this component
 * portals to the end of `<body>`, moved focus nowhere on open, trapped
 * nothing, and left the whole page behind it in the tab order. The panel also
 * carried `role="dialog" aria-modal="true"` with no accessible name at all.
 *
 * All three are fixed here rather than in one feature component, because 22
 * files render this and a focus trap written inside a feature is a focus trap
 * that rots. Nothing about the visual result changes, and no prop was added:
 * a drawer that was reachable before is reachable now, in one Tab instead of
 * forty-one.
 */
export function Drawer({ open, onClose, title, subtitle, footer, children, className, width, overlay }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<Element | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /**
   * The Tab trap is bound to the PANEL, not to `document`, and it defers to
   * anything that has already handled the key.
   *
   * Both of those are about the 22 consumers rather than about this drawer:
   * `ProductDrawer` and `StudioConfirm` already implement their own traps, and
   * several drawers carry `autoFocus` inputs. A document-level handler here
   * would fire before theirs and quietly take over; a panel-level one only
   * sees keystrokes from inside this drawer, and `defaultPrevented` means a
   * consumer that has its own opinion keeps it.
   */
  useEffect(() => {
    if (!open) return
    const el = panel.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key !== 'Tab' || !panel.current) return
      // Cycle within the panel. Read the focusables fresh on every Tab: a
      // drawer's contents change as the form fills in, and a list captured on
      // open would send focus to a node that has since gone.
      const items = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )
      const list = [...items].filter((el) => el.offsetParent !== null || el.tagName === 'SUMMARY')
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      // `active === panel.current` is the state right after opening, before the
      // first Tab. Without it here, Shift+Tab from a freshly opened drawer
      // walks backwards out of the panel into the page behind — which is the
      // leak this trap exists to close, arriving through the one door nobody
      // tests.
      if (
        e.shiftKey &&
        (active === first || active === panel.current || !panel.current.contains(active))
      ) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (!panel.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [open])

  // Focus moves in on open and back to the opener on close — otherwise closing
  // a drawer drops the caret at the top of the document and the operator has
  // to find their place again.
  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement
    const t = window.setTimeout(() => {
      // Never steal focus from something that already has it inside the panel.
      // Several consumers put `autoFocus` on their first input, and React sets
      // that on mount — before this timeout — so taking it back would turn a
      // considered choice into a worse default.
      if (panel.current && !panel.current.contains(document.activeElement)) {
        panel.current.focus()
      }
    }, 0)
    return () => {
      window.clearTimeout(t)
      const back = returnTo.current
      if (back instanceof HTMLElement && document.contains(back)) back.focus()
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="nds-drawer-bd" onClick={onClose} />
      <div
        ref={panel}
        className={`nds-drawer${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        // The panel itself is the initial focus target, so a screen reader
        // announces the dialog and its name before anything inside it. -1 keeps
        // it out of the tab sequence afterwards.
        tabIndex={-1}
        aria-labelledby={title != null ? titleId : undefined}
        style={width != null ? { width: typeof width === 'number' ? `${width}px` : width } : undefined}
      >
        <div className="nds-drawer-h">
          <div className="nds-drawer-ht">
            <span className="t" id={title != null ? titleId : undefined}>{title}</span>
            {subtitle != null && <span className="st">{subtitle}</span>}
          </div>
          <button type="button" className="nds-modal-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="nds-drawer-b">{children}</div>
        {footer != null && <div className="nds-drawer-f">{footer}</div>}
        {overlay != null && <div className="nds-drawer-ov">{overlay}</div>}
      </div>
    </>,
    document.body,
  )
}
