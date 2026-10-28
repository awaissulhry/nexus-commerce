'use client'

import { useEffect, useRef, type ReactNode } from 'react'

export interface DrawerOverlayCardProps {
  /** Id of the card's visible heading — its accessible name. */
  labelledBy?: string
  /** Accessible name when the card has no visible heading. */
  label?: string
  /** `alertdialog` for a confirmation that interrupts; `dialog` (default) for a short form. */
  role?: 'dialog' | 'alertdialog'
  /**
   * Esc. Leave it out while the card is busy (a write in flight): Esc is then still swallowed, so it
   * can never close the drawer behind a pending question.
   */
  onCancel?: () => void
  children: ReactNode
  className?: string
  testId?: string
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * The surface for a question asked INSIDE a drawer — what goes in `Drawer`'s `overlay` slot, which
 * is only a scrim. Without a surface, the question's text sits straight on the scrim (measured on
 * the publish history drawer: dark text on a 68% scrim).
 *
 * While it is up it owns the keyboard, in the capture phase so nothing behind it gets a turn:
 *   • Esc cancels the question — never the drawer behind it (a docked drawer closes on Esc too);
 *   • Tab and Shift+Tab cycle inside the card, also when focus starts outside it (a click on the
 *     scrim), because a docked drawer has no focus trap of its own and the page beside it is live.
 *
 * Focus on open is the content's call (an `autoFocus` on the one input, or the caller focusing
 * Cancel first for a destructive question).
 */
export function DrawerOverlayCard({ labelledBy, label, role = 'dialog', onCancel, children, className, testId }: DrawerOverlayCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const focusables = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
    const onKey = (event: KeyboardEvent) => {
      const root = cardRef.current
      if (!root) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel?.()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables(root)
      if (!items.length) return
      const edge = event.shiftKey ? items[0] : items[items.length - 1]
      const wrapTo = event.shiftKey ? items[items.length - 1] : items[0]
      const active = document.activeElement as HTMLElement | null
      if (active === edge || !root.contains(active)) {
        event.preventDefault()
        event.stopPropagation()
        wrapTo.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <div
      ref={cardRef}
      className={['nds-drawer-ovcard', className].filter(Boolean).join(' ')}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      data-testid={testId}
    >
      {children}
    </div>
  )
}
