'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'
import { DETAIL_POPOVER_FOCUSABLE, detailPopoverClickAway, detailPopoverKey, detailPopoverOpenFocus } from './detailPopoverKeys'

export interface DetailPopoverProps {
  /** Rendered INSIDE the trigger, which is a real `<button>`. */
  trigger: ReactNode
  /** The trigger's accessible name — the whole sentence, not the visible abbreviation. */
  triggerLabel: string
  triggerClassName?: string
  /**
   * Added to the panel beside `nds-detailpop`. For a panel with a long list: `nds-detailpop-scroll` caps the panel to
   * the room `usePopoverPosition` publishes (`--nds-popover-room`), so its header and footer stay put and the list
   * between them scrolls (the progress card, 2026-09-26).
   */
  panelClassName?: string
  /** The panel's accessible name. The panel is a NON-modal dialog. */
  label: string
  /** The panel's content. The function form receives `close`, so an action can close the panel. */
  children: ReactNode | ((api: { close: (options?: { returnFocus?: boolean }) => void }) => ReactNode)
  /** ms a pointer must rest on the trigger before the panel opens. `0` = click and keyboard only. */
  hoverDelay?: number
  /** Where focus goes when Esc closes the panel. Default: the trigger. A grid passes its cell. */
  returnFocus?: () => void
  /** Controlled mode (optional). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * A toggletip: a real button that opens a small, non-modal DIALOG which can hold actions.
 *
 * 🔴 Why this is not `HoverCard`. `HoverCard` takes text only, opens on mouse only, closes on the
 * trigger's `mouseleave` and is `role="tooltip"` — ARIA forbids interactive content in a tooltip, and a
 * link in it could never be reached by pointer or keyboard. 23 call sites rely on that meaning, so it is
 * left alone and this is the DS's answer for "a hover panel with a button in it" (DS-GAPS, 2026-09-24).
 *
 * Behaviour: click / Enter / Space toggles; a pointer resting `hoverDelay` ms opens it too, and a short
 * bridge keeps a HOVER-opened panel open while the pointer moves from the trigger onto the panel; Tab stays
 * inside; Esc closes and returns focus; a click outside closes without moving focus. The keyboard rule is
 * `detailPopoverKeys.ts` (pure, tested). Portaled to `<body>` above drawers (`--nds-z-popover`), placed by
 * `usePopoverPosition` (flips when there is no room, never clipped by a scrolling grid).
 */
export function DetailPopover({ trigger, triggerLabel, triggerClassName, panelClassName, label, children, hoverDelay = 350, returnFocus, open: controlled, onOpenChange }: DetailPopoverProps) {
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const via = useRef<'click' | 'keyboard' | 'hover'>('click')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()
  const { popRef, style } = usePopoverPosition(open, triggerRef, { width: 'auto', offset: 6 })

  const setOpen = useCallback((next: boolean) => {
    if (controlled === undefined) setOwn(next)
    onOpenChange?.(next)
  }, [controlled, onOpenChange])

  const close = useCallback((options?: { returnFocus?: boolean }) => {
    clearTimeout(hoverTimer.current); clearTimeout(leaveTimer.current)
    setOpen(false)
    if (options?.returnFocus) (returnFocus ?? (() => triggerRef.current?.focus()))()
  }, [returnFocus, setOpen])

  useClickAway([triggerRef, popRef], () => { if (detailPopoverClickAway().action === 'close') close() }, open)
  useEffect(() => () => { clearTimeout(hoverTimer.current); clearTimeout(leaveTimer.current) }, [])

  // Focus on open, by how it was opened: into the panel for click / keyboard, never for hover.
  useLayoutEffect(() => {
    if (!open) return
    const panel = popRef.current
    if (!panel) return
    const items = [...panel.querySelectorAll<HTMLElement>(DETAIL_POPOVER_FOCUSABLE)]
    const target = detailPopoverOpenFocus(via.current, items.length)
    if (target === null) return
    ;(target === -1 ? panel : items[target])?.focus()
  }, [open, popRef])

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(DETAIL_POPOVER_FOCUSABLE)]
    const result = detailPopoverKey(event.key, event.shiftKey, items.indexOf(document.activeElement as HTMLElement), items.length)
    if (result.action === 'none') return
    event.preventDefault()
    event.stopPropagation()
    if (result.action === 'close') close({ returnFocus: result.returnFocus })
    else (result.index === -1 ? event.currentTarget : items[result.index])?.focus()
  }

  const hoverIn = () => {
    clearTimeout(leaveTimer.current)
    if (open || hoverDelay <= 0) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => { via.current = 'hover'; setOpen(true) }, hoverDelay)
  }
  const hoverOut = () => {
    clearTimeout(hoverTimer.current)
    // Only a HOVER-opened panel follows the pointer; one opened on purpose stays until Esc or a click away.
    if (open && via.current === 'hover') leaveTimer.current = setTimeout(() => close(), 150)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={['nds-detailpop-trigger', triggerClassName].filter(Boolean).join(' ')}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-cell-detail-trigger=""
        onClick={(event) => {
          clearTimeout(hoverTimer.current)
          if (open && via.current !== 'hover') { close(); return }
          // `detail === 0` is a click synthesised from Enter / Space.
          const how = event.detail === 0 ? 'keyboard' : 'click'
          via.current = how
          if (!open) { setOpen(true); return }
          // Opened by hover, now clicked on purpose: it stays (no longer follows the pointer) and takes focus,
          // exactly as an intentional open does.
          const panel = popRef.current
          if (!panel) return
          const items = [...panel.querySelectorAll<HTMLElement>(DETAIL_POPOVER_FOCUSABLE)]
          const target = detailPopoverOpenFocus(how, items.length)
          if (target !== null) (target === -1 ? panel : items[target])?.focus()
        }}
        onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close({ returnFocus: true }) } }}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        {trigger}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div id={id} ref={popRef} style={style} className={['nds-detailpop', panelClassName].filter(Boolean).join(' ')} role="dialog" aria-modal="false" aria-label={label} tabIndex={-1}
          onKeyDown={onPanelKeyDown} onMouseEnter={() => clearTimeout(leaveTimer.current)} onMouseLeave={hoverOut}>
          {typeof children === 'function' ? children({ close }) : children}
        </div>,
        document.body,
      )}
    </>
  )
}
