'use client'

import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'
import { searchOptions } from '../lib/option-search'

export interface MultiSelectOption {
  value: string
  label: ReactNode
}

export interface MultiSelectProps {
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  /** label shown when nothing is selected (default "All") */
  placeholder?: string
  className?: string
  ariaLabel?: string
  /** force the in-popover search box; it otherwise appears past SEARCH_THRESHOLD options */
  searchable?: boolean
  searchPlaceholder?: string
}

/** Past this many options a picker gets a search box without being asked. */
const SEARCH_THRESHOLD = 7

/** Checkbox multi-select dropdown (H10 `.h10-ms`): "All" / "N selected" + Select-all. */
export function MultiSelect({ options, value, onChange, placeholder = 'All', className,
  ariaLabel, searchable, searchPlaceholder = 'Search…' }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)

  const allChecked = value.length === options.length && options.length > 0
  const label = value.length === 0 ? placeholder : allChecked ? 'All' : `${value.length} selected`
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  // Select all deliberately applies to ALL options, not the filtered subset — a control labelled
  // "Select all" that silently selected a search result would be a lie.
  const toggleAll = () => onChange(allChecked ? [] : options.map((o) => o.value))
  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const matches = showSearch ? searchOptions(q, options, (o) => (typeof o.label === 'string' ? o.label : o.value)) : options

  return (
    <div className={`nds-ms${className ? ` ${className}` : ''}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setOpen(false))}>
      <button type="button" className="nds-ms-btn" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        <span className={value.length === 0 ? 'ph' : ''}>{label}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        createPortal(
          <div ref={popRef} style={popStyle} className="nds-ms-pop" role="listbox" aria-multiselectable="true">
            {showSearch && (
              <div className="nds-combo-search">
                <Search size={13} aria-hidden />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label="Search options" />
              </div>
            )}
            <label className="nds-ms-opt all">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = value.length > 0 && !allChecked
                }}
                onChange={toggleAll}
              />
              <span>Select all</span>
            </label>
            {matches.length === 0 && <div className="nds-combo-empty">No matches</div>}
            {matches.map((o) => (
              <label key={o.value} className={['nds-ms-opt', value.includes(o.value) ? 'sel' : ''].filter(Boolean).join(' ')}>
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
