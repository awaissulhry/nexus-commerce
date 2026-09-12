'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ToolbarButton } from '../primitives/ToolbarButton'

export interface DrawerProps {
  id?: string
  /** Viewport coordinates supplied by the shell; no layout space is reserved. */
  inset?: { top: number; left: number }
  side?: 'left' | 'right'
  backdrop?: 'dimmed' | 'transparent'
  closeLabel?: string
  closeIcon?: ReactNode
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
  /**
   * PES.4.1 — which of the two drawers this is.
   *
   * `modal` (default, and what all 22 existing consumers get byte-for-byte) is
   * a slide-over: fixed to the viewport's right edge, backdrop, `aria-modal`,
   * focus trapped inside. The page behind it is inert on purpose.
   *
   * `dock` is the opposite contract, and the difference is not cosmetic. A
   * docked drawer is a SECOND pane of one workspace: it renders in the normal
   * flow so the surface beside it reflows instead of being covered, it takes
   * no backdrop and no `aria-modal`, it never traps focus, and it never steals
   * focus on open. That is what makes "expand the record without leaving the
   * sheet" true rather than a claim — the grid behind a dock is still
   * keyboard-navigable, still editable, still the thing the operator is doing.
   *
   * A dock is therefore laid out by its PARENT: put it in a flex row beside
   * the surface it annotates. It contributes its own width and full height.
   */
  /** `embedded` renders the editor in its parent's layout, without covering shell navigation. */
  mode?: 'modal' | 'dock' | 'embedded'
  /**
   * Dock only — a drag handle on the panel's leading edge. The width stays
   * CONTROLLED (`width` + `onWidthChange`) so the owner can persist it; this
   * component never remembers a size the operator chose.
   */
  resizable?: boolean
  /** Dock resize floor, px. Default 360. */
  minWidth?: number
  /** Dock resize ceiling, px. Default 900. */
  maxWidth?: number
  /** Fires continuously while dragging (and on each arrow-key nudge), in px. */
  onWidthChange?: (width: number) => void
}

/**
 * Right-side panel, in two modes.
 *
 *   modal (default)  slide-over portaled to <body>; backdrop, aria-modal, Esc
 *                    and backdrop close, focus trapped inside.
 *   dock (PES.4.1)   a second pane in the normal flow beside a live surface:
 *                    no portal, no backdrop, not aria-modal, no focus trap, no
 *                    focus steal, optional drag/arrow-key resize. Lay it out
 *                    yourself — put it in a flex row next to what it annotates.
 *
 * Both render the same header/body/footer/overlay DOM, so a drawer cannot look
 * like two different components depending on where it is standing.
 *
 * Everything below describes the modal mode, and still holds for it exactly.
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
export function Drawer({
  id,
  inset,
  side = 'right',
  backdrop = 'dimmed',
  closeLabel = 'Close',
  closeIcon,
  open,
  onClose,
  title,
  subtitle,
  footer,
  children,
  className,
  width,
  overlay,
  mode = 'modal',
  resizable = false,
  minWidth = 360,
  maxWidth = 900,
  onWidthChange,
}: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<Element | null>(null)
  const titleId = useId()
  const dock = mode === 'dock'
  const embedded = mode === 'embedded'

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // An embedded editor must not close when Escape dismisses workspace navigation or a
      // separate dialog. Only a key from its own content belongs to this panel.
      if (embedded && (!panel.current?.contains(document.activeElement) || document.activeElement?.closest('[role="dialog"]'))) return
      /**
       * §5.2 — Esc belongs to the INNERMOST focused thing, which is the only rule under which it
       * never surprises. Three cases, and the middle one is why this is not simply "close":
       *
       *   focus inside the panel        → close the panel
       *   focus in a CELL EDITOR        → the editor reverts the edit; the panel must not close
       *   focus in the grid, not editing → close the panel
       *
       * The middle case is the whole point. A non-modal panel leaves the sheet live, so an
       * operator can be mid-edit in a cell with the drawer open; swallowing that Esc would revert
       * their edit AND close the record they were checking it against. AG marks an open editor on
       * the cell, so the question is answerable without the drawer knowing anything about grids.
       */
      if (dock) {
        const active = document.activeElement
        const editing = active?.closest?.('.ag-cell-inline-editing, .ag-popup-editor') != null
        if (editing) return
      }
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, dock, embedded])

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
    // A dock has no trap, by definition. Trapping Tab inside a panel that sits
    // BESIDE a live grid would strand the operator in the panel: the surface
    // the dock annotates is the one they need to Tab back to.
    if (dock || embedded) return
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
      const list = [...items].filter((el) => {
        if (el.tabIndex < 0 || !el.getClientRects().length || el.closest('[hidden], [inert]')) return false
        const visibility = window.getComputedStyle(el).visibility
        if (visibility === 'hidden' || visibility === 'collapse') return false
        // Closed details can retain descendant geometry in Chromium. Only their own
        // summary is a tab stop; focusing a hidden descendant silently does nothing.
        for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') && !ancestor.querySelector(':scope > summary')?.contains(el)) return false
        }
        return true
      })
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
  }, [open, dock, embedded])

  // Focus moves in on open and back to the opener on close — otherwise closing
  // a drawer drops the caret at the top of the document and the operator has
  // to find their place again.
  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement
    /**
     * §5.2 — focus moves to the panel's HEADING on open, and is never trapped.
     *
     * The docked version deliberately took no focus, because it sat beside a sheet the operator
     * was still arrowing through. A slide-over OVERLAYS that sheet, so an operator who opened a
     * record and cannot Tab into it has to reach for the mouse; and a screen-reader user gets no
     * announcement at all that anything happened. Moving focus to the heading answers both without
     * trapping: Tab still leaves the panel and reaches the sheet, which is correct for non-modal.
     */
    const t = window.setTimeout(() => {
      // Never steal focus from something that already has it inside the panel.
      // Several consumers put `autoFocus` on their first input, and React sets
      // that on mount — before this timeout — so taking it back would turn a
      // considered choice into a worse default.
      if (!panel.current || panel.current.contains(document.activeElement)) return
      // The HEADING, not the panel box — a reader then announces the record's name rather than an
      // unnamed region, and the caret lands where the content starts.
      const heading = panel.current.querySelector<HTMLElement>('[data-drawer-heading]')
      ;(heading ?? panel.current).focus()
    }, 0)
    return () => {
      if (t !== undefined) window.clearTimeout(t)
      /**
       * §5.2 — focus returns to the CELL THAT OPENED IT, and this is not politeness.
       *
       * "Losing your place in a 21-row family is the real cost of a slide-over, and this is the
       * whole fix." The panel now takes focus on open, so it always owes it back — the earlier
       * `hadFocus` guard existed for a dock that usually never held focus at all, and keeping it
       * would strand the caret at the top of the document on every close.
       */
      const back = returnTo.current
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true })
    }
  }, [open, dock])

  /**
   * Pointer resize. The grip is on the panel's LEADING (left) edge and the
   * panel is right-anchored, so the drag delta is inverted: moving left grows
   * it. The listeners go on `document`, not the grip — a pointer that outruns
   * the handle mid-drag must keep resizing, not drop the gesture.
   */
  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = panel.current
      if (!onWidthChange || !el) return
      e.preventDefault()
      const startX = e.clientX
      const startW = el.getBoundingClientRect().width
      const move = (ev: PointerEvent) => {
        onWidthChange(Math.min(maxWidth, Math.max(minWidth, Math.round(startW - (ev.clientX - startX)))))
      }
      const up = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.body.classList.remove('nds-drawer-resizing')
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      // Kills text selection and keeps the col-resize cursor while the pointer
      // is anywhere on the page, not just over the 6px grip.
      document.body.classList.add('nds-drawer-resizing')
    },
    [onWidthChange, minWidth, maxWidth],
  )

  /** A splitter that only answers the mouse is a splitter half the operators cannot move. */
  const nudge = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const el = panel.current
      if (!onWidthChange || !el) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const step = e.shiftKey ? 64 : 16
      const cur = el.getBoundingClientRect().width
      const next = e.key === 'ArrowLeft' ? cur + step : cur - step
      onWidthChange(Math.min(maxWidth, Math.max(minWidth, Math.round(next))))
    },
    [onWidthChange, minWidth, maxWidth],
  )

  if (!open) return null

  // Identical DOM for both modes — a dock is the same drawer in a different
  // place, not a second drawer that drifts from this one.
  const inner = (
    <>
      <div className="nds-drawer-h">
        <div className="nds-drawer-ht">
          <span className="t" id={title != null ? titleId : undefined} {...(embedded ? { tabIndex: -1, 'data-drawer-heading': true } : {})}>{title}</span>
          {subtitle != null && <span className="st">{subtitle}</span>}
        </div>
        {closeIcon ? (
          <ToolbarButton icon={closeIcon} label={closeLabel} onClick={onClose} />
        ) : (
          <button type="button" className="nds-modal-x" onClick={onClose} aria-label={closeLabel}>
            <X size={18} />
          </button>
        )}
      </div>
      <div className="nds-drawer-b">{children}</div>
      {footer != null && <div className="nds-drawer-f">{footer}</div>}
      {overlay != null && <div className="nds-drawer-ov">{overlay}</div>}
    </>
  )

  if (dock || embedded) {
    const px = typeof width === 'number' ? width : undefined
    return (
      <aside
        ref={panel}
        id={`${titleId}-panel`}
        className={`${embedded ? 'nds-drawer-embedded' : 'nds-drawer-dock'}${className ? ` ${className}` : ''}`}
        // Deliberately NOT role="dialog" aria-modal. Nothing behind a dock is
        // inert, and telling a screen reader otherwise would make the rest of
        // the page unreachable to it while staying perfectly usable with a
        // mouse. `<aside>` is the complementary landmark this actually is.
        aria-labelledby={title != null ? titleId : undefined}
        style={px != null ? { width: `${px}px` } : width != null ? { width } : undefined}
      >
        {dock && resizable && onWidthChange != null && (
          <div
            className="nds-drawer-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-controls={`${titleId}-panel`}
            aria-valuenow={px}
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={nudge}
          />
        )}
        {inner}
      </aside>
    )
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className={`nds-drawer-bd${backdrop === 'transparent' ? ' transparent' : ''}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }} />
      <div
        id={id}
        ref={panel}
        className={`nds-drawer${side === 'left' ? ' from-left' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        // The panel itself is the initial focus target, so a screen reader
        // announces the dialog and its name before anything inside it. -1 keeps
        // it out of the tab sequence afterwards.
        tabIndex={-1}
        aria-labelledby={title != null ? titleId : undefined}
        style={{
          ...(width != null ? { width: typeof width === 'number' ? `${width}px` : width } : {}),
          ...(inset ? { top: inset.top, left: inset.left, right: 'auto', bottom: 0, height: 'auto', maxWidth: `calc(100vw - ${inset.left}px)` } : {}),
        }}
      >
        {inner}
      </div>
    </>,
    document.body,
  )
}
