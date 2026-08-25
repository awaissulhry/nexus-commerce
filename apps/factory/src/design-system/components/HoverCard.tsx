'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface HoverCardProps {
  /** single-line hint. Takes precedence over `rows`. */
  text?: string
  /** key/value rows, rendered as a small definition list */
  rows?: Array<[string, string]>
  /** preferred side; flips automatically when that side has no room */
  placement?: 'above' | 'below'
  /** ms before a COLD hover shows. A hover within 350ms of the last hide is "warm" and shows at once. */
  delay?: number
  /**
   * Checked at hover time — return true to suppress. The DS must not know about any app's
   * interaction state, so a caller that has one (a column drag, a resize) passes it in here.
   */
  shouldSuppress?: () => boolean
  children: ReactNode
  className?: string
}

/**
 * Rich hover panel, portaled to <body> and positioned with fixed coordinates.
 *
 * The portal is the whole point and the reason the previous CSS-only version had ZERO adoption:
 * an absolutely-positioned card is clipped by any scroll container, and the surfaces that want a
 * hover card are grids with `overflow: auto`. This one escapes that, clamps itself horizontally
 * to the viewport, and flips above↔below when the preferred side has no room.
 *
 * The "warm window" is shared across every instance on the page: once one card has just hidden,
 * moving onto another shows immediately, so sweeping across a row of triggers does not stutter.
 */
let lastHide = 0

export function HoverCard({
  text,
  rows,
  placement = 'above',
  delay = 0,
  shouldSuppress,
  children,
  className,
}: HoverCardProps) {
  const [pos, setPos] = useState<{ top: number; left: number; place: 'above' | 'below' } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const place = () => {
    if (shouldSuppress?.()) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ top: placement === 'below' ? r.bottom + 6 : r.top - 6, left: r.left, place: placement })
  }
  const show = () => {
    if (shouldSuppress?.()) return
    clearTimeout(timer.current)
    const warm = performance.now() - lastHide < 350
    if (delay > 0 && !warm) timer.current = setTimeout(place, delay)
    else place()
  }
  const hide = () => {
    clearTimeout(timer.current)
    lastHide = performance.now()
    setPos(null)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  // Measure the mounted card so it can be kept on-screen. The equality guard is what stops this
  // from re-rendering forever.
  useLayoutEffect(() => {
    if (!pos || !cardRef.current || !ref.current) return
    const c = cardRef.current.getBoundingClientRect()
    const a = ref.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const m = 8
    let left = pos.left
    let place = pos.place
    if (left + c.width > vw - m) left = vw - m - c.width
    if (left < m) left = m
    if (place === 'above' && a.top - c.height - 6 < m) place = 'below'
    else if (place === 'below' && a.bottom + c.height + 6 > vh - m) place = 'above'
    const top = place === 'below' ? a.bottom + 6 : a.top - 6
    if (left !== pos.left || place !== pos.place || top !== pos.top) setPos({ top, left, place })
  }, [pos])

  return (
    <span
      className={['nds-hovercard', className].filter(Boolean).join(' ')}
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {pos != null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={cardRef}
            className={`nds-hovercard-card ${pos.place}`}
            style={{ top: pos.top, left: pos.left }}
            role="tooltip"
          >
            {text != null ? (
              <div className="r1">{text}</div>
            ) : (
              (rows ?? []).map(([k, v]) => (
                <div className="r" key={k}>
                  <b className="k">{k}:</b> <span className="v">{v}</span>
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </span>
  )
}
