'use client'

/**
 * Anchored popover primitive.
 *
 * Renders its children in a portal to document.body with `position:
 * fixed` so the panel always layers above any sidebar, sticky header,
 * or ancestor stacking context. The anchor button's bounding rect is
 * measured on open + on resize + on any (capture-phase) scroll so the
 * panel tracks the trigger when ancestors scroll.
 *
 * The panel is clamped to the page's content area (the right edge of
 * the sidebar through the right edge of the viewport) — never spills
 * onto the sidebar, never off-screen. Width is capped via maxWidth
 * derived purely from the content bounds (NOT from scrollWidth, which
 * would create a feedback loop where each measurement shrunk the
 * panel further on scroll).
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface AnchoredPopoverProps {
  /** Ref to the trigger element. Used to compute panel position. */
  anchorRef: RefObject<HTMLElement | null>
  /** Called when the user clicks outside or presses Escape. */
  onClose: () => void
  /** Which edge of the panel aligns to the anchor. */
  align?: 'right' | 'left'
  /** Vertical pixel offset from the bottom of the anchor (default 4). */
  offsetY?: number
  /** Min distance the panel keeps from the page content edges (default 8). */
  edgePad?: number
  /** Stacking layer above all app chrome. Default z-[1000]. */
  zClass?: string
  /** Optional ARIA role on the panel wrapper (default "dialog"). */
  role?: string
  /** Optional ARIA label on the panel wrapper. */
  ariaLabel?: string
  className?: string
  children: ReactNode
}

interface Coords {
  top: number
  /** One of left / right is set (CSS anchor) — the other is undefined. */
  left?: number
  right?: number
  maxWidth: number
  maxHeight: number
}

const MAIN_ID = 'main-content'

/**
 * Bounding box of the page's content area. Falls back to the viewport
 * when the main element isn't there (different layout).
 */
function getContentBounds(): { left: number; right: number; top: number; bottom: number } {
  const main = typeof document !== 'undefined' ? document.getElementById(MAIN_ID) : null
  if (main) {
    const r = main.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }
  return {
    left: 0,
    right: typeof window !== 'undefined' ? window.innerWidth : 0,
    top: 0,
    bottom: typeof window !== 'undefined' ? window.innerHeight : 0,
  }
}

export function AnchoredPopover({
  anchorRef,
  onClose,
  align = 'right',
  offsetY = 4,
  edgePad = 8,
  zClass = 'z-[1000]',
  role = 'dialog',
  ariaLabel,
  className,
  children,
}: AnchoredPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<Coords | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current
      if (!anchor) return

      const btn = anchor.getBoundingClientRect()
      const bounds = getContentBounds()
      const vpW = typeof window !== 'undefined' ? window.innerWidth : bounds.right
      const vpH = typeof window !== 'undefined' ? window.innerHeight : 0

      // Horizontal: anchor one edge of the panel to the corresponding
      // edge of the trigger; cap maxWidth so the OPPOSITE edge can't
      // cross the page content bounds. maxWidth derives ONLY from
      // bounds + anchor — never from the panel's own measured width —
      // so re-measures on scroll can't create a shrinking feedback
      // loop.
      let left: number | undefined
      let right: number | undefined
      let maxWidth: number
      if (align === 'right') {
        right = Math.max(edgePad, vpW - btn.right)
        // Panel's right edge sits at btn.right; its left edge must
        // stay ≥ bounds.left + edgePad. So:
        maxWidth = btn.right - (bounds.left + edgePad)
      } else {
        left = Math.max(bounds.left + edgePad, btn.left)
        maxWidth = bounds.right - edgePad - (left ?? 0)
      }
      maxWidth = Math.max(160, maxWidth) // sanity floor

      // Vertical: open below by default; flip above if there's
      // visibly more room above. Cap with a maxHeight so the panel
      // never overflows the viewport bottom.
      const spaceBelow = vpH - btn.bottom - offsetY - edgePad
      const spaceAbove = btn.top - offsetY - edgePad
      let top: number
      let maxHeight: number
      if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
        top = btn.bottom + offsetY
        maxHeight = Math.max(160, spaceBelow)
      } else {
        // Flip above: anchor the panel's bottom at btn.top - offsetY.
        // Without measuring panel.scrollHeight (avoiding the same
        // feedback loop), give it the full spaceAbove and let the
        // panel's internal max-h handle scroll.
        top = Math.max(edgePad, btn.top - offsetY - spaceAbove)
        maxHeight = Math.max(160, spaceAbove)
      }

      setCoords({ top, left, right, maxWidth, maxHeight })
    }

    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [anchorRef, align, offsetY, edgePad])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: coords?.top ?? -9999,
        left: coords?.left,
        right: coords?.right,
        maxWidth: coords?.maxWidth,
        maxHeight: coords?.maxHeight,
        opacity: coords ? 1 : 0,
        zIndex: 1000,
      }}
      className={[zClass, className ?? ''].filter(Boolean).join(' ')}
    >
      {children}
    </div>,
    document.body,
  )
}
