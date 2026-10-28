'use client'

import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../primitives'

export interface FilterPanelProps {
  title?: ReactNode
  /** preset buttons row */
  presets?: ReactNode
  /** the field grid — compose `FilterField` children */
  children: ReactNode
  onReset?: () => void
  onApply?: () => void
  /** Label for the reset button (default "Reset"; pass "Clear" to match the Ad Manager). */
  resetLabel?: string
  /** Disable the reset button (e.g. when no filters are active). */
  resetDisabled?: boolean
  /** extra left-aligned footer slot (e.g. "Save to library") */
  footerExtra?: ReactNode
  defaultOpen?: boolean
  /**
   * Controlled open state (2026-10-12): a page that remembers it for the person passes `open` and `onOpenChange`.
   * Without them the panel keeps its own, starting at `defaultOpen`.
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * What is filtered now, shown in the header while the panel is collapsed (2026-10-12) — "Portfolio: Boots IT +1 ·
   * Campaign: 2 selected". One line; it ends in "…" rather than widen the page. While collapsed the header also offers
   * the reset (when it is not disabled), so a filter can be cleared without opening the panel.
   */
  summary?: ReactNode
  /** The summary on a phone, where a line of names ends in "…" after two letters: "2 on". Optional. */
  summaryShort?: ReactNode
}

/**
 * Collapsible filter panel (H10 `.h10-am-fpanel`): header + presets + a
 * responsive 6-col field grid + reset/apply footer. Compose with `FilterField`.
 *
 * Keyboard (2026-10-12): the Show / Hide toggle is named for the panel ("Show filters"), says whether it is open
 * (`aria-expanded`) and which region it opens (`aria-controls`).
 */
export function FilterPanel({ title = 'Filters', presets, children, onReset, onApply, resetLabel = 'Reset', resetDisabled, footerExtra, defaultOpen = true, open: openProp, onOpenChange, summary, summaryShort }: FilterPanelProps) {
  const [own, setOwn] = useState(defaultOpen)
  const open = openProp ?? own
  const setOpen = (next: boolean) => { if (openProp === undefined) setOwn(next); onOpenChange?.(next) }
  const bodyId = useId()
  const named = typeof title === 'string' ? title.toLowerCase() : 'filters'
  const showSummary = !open && summary != null && summary !== false && summary !== ''
  return (
    <div className={['nds-fpanel', open ? '' : 'collapsed'].filter(Boolean).join(' ')}>
      <div className="nds-fpanel-head">
        <h3>{title}</h3>
        {showSummary && <span className={summaryShort != null ? 'nds-fpanel-summary has-short' : 'nds-fpanel-summary'}>{summary}</span>}
        {showSummary && summaryShort != null && <span className="nds-fpanel-summary short">{summaryShort}</span>}
        <span className="nds-fpanel-head-end">
          {!open && onReset && !resetDisabled && (
            <Button size="sm" variant="link" onClick={onReset}>{resetLabel}</Button>
          )}
          <button type="button" className={['nds-fpanel-toggle', open ? 'open' : ''].filter(Boolean).join(' ')} onClick={() => setOpen(!open)}
            aria-expanded={open} aria-controls={open ? bodyId : undefined} aria-label={`${open ? 'Hide' : 'Show'} ${named}`}>
            {open ? 'Hide' : 'Show'}
            <ChevronDown size={15} aria-hidden />
          </button>
        </span>
      </div>
      {open && (
        <div id={bodyId} className="nds-fpanel-body">
          {presets != null && <div className="nds-fpanel-presets">{presets}</div>}
          <div className="nds-fpanel-grid">{children}</div>
          {(onReset || onApply || footerExtra != null) && (
            <div className="nds-fpanel-foot">
              {footerExtra}
              <span className="grow" />
              {onReset && (
                <Button onClick={onReset} disabled={resetDisabled}>
                  {resetLabel}
                </Button>
              )}
              {onApply && (
                <Button variant="primary" onClick={onApply}>
                  Apply
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One field of the grid: its label over its control. `labelId` (2026-10-12) puts an id on the label, so a control can
 * be named by it (`MultiSelect labelledBy`).
 */
export function FilterField({ label, wide, labelId, children }: { label: ReactNode; wide?: boolean; labelId?: string; children: ReactNode }) {
  return (
    <div className={['nds-fpanel-field', wide ? 'wide' : ''].filter(Boolean).join(' ')}>
      <span className="flbl" id={labelId}>{label}</span>
      {children}
    </div>
  )
}
