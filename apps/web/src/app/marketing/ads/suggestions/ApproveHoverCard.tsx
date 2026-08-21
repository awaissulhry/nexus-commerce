'use client'

/**
 * SG.9 — the approve-hover card, lifted out of SuggestionsClient so all seven tabs use ONE
 * implementation (shared means exactly the same — the family tabs' card, the Recommendations
 * card and the A.I. card are the same component with different content).
 *
 * H10's behaviour, kept: hovering ✓ states EXACTLY what will happen before you commit to it —
 * a title, a one-line explainer, a table of destination rows, and a button into the drawer
 * where the change can be reviewed or edited. Portaled to `body` because the ✓ lives in a
 * right-pinned sticky cell whose stacking context would clip it, bottom-anchored so it grows
 * upward, and it stays open while the pointer is over the card itself so the button is
 * clickable (grace timers on both edges).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface HoverRow {
  badge: { letter: string; cls: string } | null
  typeLabel: string
  bid: string
  campaign: string
  adProduct: string | null
  adGroup: string
  note: string
}
export interface HoverContent {
  title: string
  sub: string
  rows: HoverRow[]
  /** column headers, so a tab whose rows are not destinations can label them truthfully */
  headers?: [string, string, string, string, string]
  /** the footer button; omit for a card with nothing to open */
  action?: { label: string; onClick: () => void }
}

export function ApproveHoverCard({ content, children }: { content: () => HoverContent | null; children: ReactNode }) {
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const showT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = () => {
    clearTimeout(hideT.current)
    showT.current = setTimeout(() => {
      const r = wrapRef.current?.getBoundingClientRect()
      if (!r) return
      setPos({ bottom: window.innerHeight - r.top + 8, right: Math.max(16, window.innerWidth - r.right) })
    }, 280)
  }
  const hide = () => {
    clearTimeout(showT.current)
    hideT.current = setTimeout(() => setPos(null), 180)
  }
  useEffect(() => () => { clearTimeout(showT.current); clearTimeout(hideT.current) }, [])
  const c = pos ? content() : null
  const headers = c?.headers ?? ['Type', 'Bid', 'To Campaign', 'To Ad Group', 'Notes']
  return (
    <span ref={wrapRef} className="h10-sug-ahwrap" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {pos && c && createPortal(
        <div className="h10-sug-ahover" style={{ bottom: pos.bottom, right: pos.right }} role="tooltip" onMouseEnter={() => clearTimeout(hideT.current)} onMouseLeave={hide}>
          <b className="ti">{c.title}</b>
          <p className="sub">{c.sub}</p>
          <div className="tbl" role="table">
            <div className="hd" role="row">{headers.map((h) => <span key={h}>{h}</span>)}</div>
            {c.rows.map((r, i) => (
              <div className="rw" role="row" key={i}>
                <span className="ty">{r.badge && <i className={`h10-sug-mt ${r.badge.cls}`} aria-hidden>{r.badge.letter}</i>}{r.typeLabel}</span>
                <span className="bd">{r.bid}</span>
                <span className="cp">{r.adProduct && <i className="h10-sug-adp" aria-hidden>{r.adProduct}</i>}{r.campaign}</span>
                <span className="ag">{r.adGroup}</span>
                <span className="nt">{r.note}</span>
              </div>
            ))}
          </div>
          {c.action && (
            <div className="ft">
              <button type="button" className="h10-am-btn primary" onClick={c.action.onClick}>{c.action.label}</button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
