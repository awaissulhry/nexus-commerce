'use client'

/**
 * PortalActionBar — on a phone record page, the band's primary action in a bar just above the BottomBar, in thumb reach
 * (B-W2b-155, design part "Portal action bar").
 *
 *   <PortalActionBar action={{ label: 'Conferma tutto come richiesto', onClick: confirm, heldReason: held }}
 *                    note="3 righe come richiesto · 1 data successiva" labels={ds.portalActionBar} />
 *
 * - Under 720 px (the BottomBar's breakpoint) the bar is fixed above the BottomBar and the safe area, with a spacer in the
 *   page's flow so the last content scrolls clear of it. From 720 px it draws nothing: the action is in the band there
 *   (the page draws it once in each place; the bar's copy is gone from the page, and from the accessibility tree, on a
 *   desktop). `inline` draws it in the flow at every width (a review page, a test).
 * - Held when it cannot act: the DS Button's `heldReason` (focusable, says why) AND the reason as a line in the bar.
 *   Busy: held with "Working…" and a spinner.
 * - `secondary` takes one more control beside it (a link to the PDF, "Ask a question"); `note` one line above it.
 * - `aboveBottomBar` false: the bar sits at the bottom edge (a page with no BottomBar: the link pages).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Spinner } from '../../primitives/Spinner'
import { PORTAL_ACTION_BAR_LABELS, type PortalActionBarLabels } from './PortalActionBarLabels'
import './portalActionBar.css'

export interface PortalAction {
  label: string
  onClick?: () => void
  /** A link instead of a button. */
  href?: string
  /** Default `primary`. */
  variant?: 'primary' | 'secondary' | 'danger'
  /** Why it cannot act now, in words: held, and said in the bar. */
  heldReason?: string | null
  /** It runs: held with the busy words. */
  busy?: boolean
  /** An icon before the words. */
  icon?: ReactNode
}

export interface PortalActionBarProps {
  /** The primary action. */
  action?: PortalAction | null
  /** One more control beside it (the page's own Button). */
  secondary?: ReactNode
  /** One line above the action ("3 lines as asked · 1 later date"). */
  note?: ReactNode
  /** Sits above the DS BottomBar (default true); false: at the bottom edge. */
  aboveBottomBar?: boolean
  /** In the page's flow at every width (no fixed bar, no spacer). */
  inline?: boolean
  /** The region's name ("Order actions"). Default "Actions". */
  label?: string
  className?: string
  labels?: Partial<PortalActionBarLabels>
}

export function PortalActionBar({ action, secondary, note, aboveBottomBar = true, inline = false, label, className, labels }: PortalActionBarProps) {
  const lw = mergeLabels(PORTAL_ACTION_BAR_LABELS, labels)
  // The spacer in the page's flow is as tall as the fixed bar (its note and held line included), measured.
  const barRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    const bar = barRef.current
    if (inline || !bar || typeof ResizeObserver === 'undefined') return
    const measure = () => setHeight(bar.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [inline])
  if (!action && !secondary) return null
  const held = action ? (action.busy ? lw.busy : (action.heldReason ?? null)) : null
  const variant = action?.variant ?? 'primary'
  const bar = (
    <div
      ref={barRef}
      role="region"
      aria-label={label ?? lw.region}
      className={['nds-pab', inline ? 'inline' : '', className].filter(Boolean).join(' ')}
      data-above={aboveBottomBar && !inline ? 'bottombar' : undefined}
    >
      {note ? <div className="nds-pab-note">{note}</div> : null}
      <div className="nds-pab-row">
        {secondary ? <div className="nds-pab-secondary">{secondary}</div> : null}
        {action ? (
          action.href && !held ? (
            <Button variant={variant} size="lg" className="nds-pab-action" asChild>
              <a href={action.href}>
                {action.icon}
                {action.label}
              </a>
            </Button>
          ) : (
            <Button variant={variant} size="lg" className="nds-pab-action" heldReason={held} onClick={action.onClick}>
              {action.busy ? <Spinner size={16} /> : action.icon}
              {action.busy ? lw.busy : action.label}
            </Button>
          )
        ) : null}
      </div>
      {held && !action?.busy ? <p className="nds-pab-held">{held}</p> : null}
    </div>
  )
  if (inline) return bar
  return (
    <div className="nds-pab-host">
      <div className="nds-pab-spacer" aria-hidden style={height ? { height } : undefined} />
      {bar}
    </div>
  )
}
