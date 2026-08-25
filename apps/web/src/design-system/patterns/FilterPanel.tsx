'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/design-system/primitives'

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
}

/**
 * Collapsible filter panel (H10 `.h10-am-fpanel`): header + presets + a
 * responsive 6-col field grid + reset/apply footer. Compose with `FilterField`.
 */
export function FilterPanel({ title = 'Filters', presets, children, onReset, onApply, resetLabel = 'Reset', resetDisabled, footerExtra, defaultOpen = true }: FilterPanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={['nds-fpanel', open ? '' : 'collapsed'].filter(Boolean).join(' ')}>
      <div className="nds-fpanel-head">
        <h3>{title}</h3>
        <button type="button" className={['nds-fpanel-toggle', open ? 'open' : ''].filter(Boolean).join(' ')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
          <ChevronDown size={15} />
        </button>
      </div>
      {open && (
        <>
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
        </>
      )}
    </div>
  )
}

export function FilterField({ label, wide, children }: { label: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={['nds-fpanel-field', wide ? 'wide' : ''].filter(Boolean).join(' ')}>
      <span className="flbl">{label}</span>
      {children}
    </div>
  )
}
