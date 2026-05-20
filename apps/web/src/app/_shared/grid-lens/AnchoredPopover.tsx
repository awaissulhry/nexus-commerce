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
 * the sidebar through the right edge of the viewport) so it never
 * spills onto the sidebar OR off-screen. When the natural width would
 * overflow, the panel shrinks; when it would extend past the viewport
 * bottom, it gets a maxHeight and scrolls.
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
  left: number
  maxWidth: number
  maxHeight: number
}

const MAIN_ID = 'main-content'

/**
 * Find the bounding box of the page's content area. Falls back to the
 * viewport when the main element isn't there (e.g. a different layout).
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
      const panel = panelRef.current
      if (!anchor || !panel) return

      const btn = anchor.getBoundingClientRect()
      const bounds = getContentBounds()

      // Available space inside the page content area.
      const availW = Math.max(0, bounds.right - bounds.left - edgePad * 2)
      const naturalW = panel.scrollWidth
      const width = Math.min(naturalW, availW)

      // Horizontal position. Default: align to the requested edge of
      // the anchor, then clamp into the page bounds so the panel never
      // crosses onto the sidebar or off the right edge of the viewport.
      let left =
        align === 'right'
          ? btn.right - width
          : btn.left
      left = Math.max(bounds.left + edgePad, Math.min(left, bounds.right - width - edgePad))

      // Vertical position. Open below the anchor; flip above if there
      // isn't enough room below. Cap with a maxHeight so the panel
      // never overflows the bottom of the viewport.
      const vpH = window.innerHeight
      const spaceBelow = vpH - btn.bottom - offsetY - edgePad
      const spaceAbove = btn.top - offsetY - edgePad
      let top: number
      let maxHeight: number
      if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
        top = btn.bottom + offsetY
        maxHeight = spaceBelow
      } else {
        // Flip above
        const naturalH = panel.scrollHeight
        const h = Math.min(naturalH, spaceAbove)
        top = btn.top - offsetY - h
        maxHeight = spaceAbove
      }

      setCoords({ top, left, maxWidth: width, maxHeight })
    }

    // First paint with opacity 0 lets us measure the natural width
    // before clamping. requestAnimationFrame gives the browser one
    // frame to apply intrinsic sizing.
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(raf)
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
        left: coords?.left ?? -9999,
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
