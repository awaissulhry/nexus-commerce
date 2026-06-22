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
  /** extra left-aligned footer slot (e.g. "Save to library") */
  footerExtra?: ReactNode
  defaultOpen?: boolean
}

/**
 * Collapsible filter panel (H10 `.h10-am-fpanel`): header + presets + a
 * responsive 6-col field grid + reset/apply footer. Compose with `FilterField`.
 */
export function FilterPanel({ title = 'Filters', presets, children, onReset, onApply, footerExtra, defaultOpen = true }: FilterPanelProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={['h10-ds-fpanel', open ? '' : 'collapsed'].filter(Boolean).join(' ')}>
      <div className="h10-ds-fpanel-head">
        <h3>{title}</h3>
        <button type="button" className={['h10-ds-fpanel-toggle', open ? 'open' : ''].filter(Boolean).join(' ')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
          <ChevronDown size={15} />
        </button>
      </div>
      {open && (
        <>
          {presets != null && <div className="h10-ds-fpanel-presets">{presets}</div>}
          <div className="h10-ds-fpanel-grid">{children}</div>
          {(onReset || onApply || footerExtra != null) && (
            <div className="h10-ds-fpanel-foot">
              {footerExtra}
              <span className="grow" />
              {onReset && <Button onClick={onReset}>Reset</Button>}
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
    <div className={['h10-ds-fpanel-field', wide ? 'wide' : ''].filter(Boolean).join(' ')}>
      <span className="flbl">{label}</span>
      {children}
    </div>
  )
}
