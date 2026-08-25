'use client'

import { useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { searchOptions } from '../lib/option-search'

export interface ListboxOption {
  value: string
  label: string
  disabled?: boolean
}

export interface ListboxProps {
  options: ListboxOption[]
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
  /** trigger width. Every one of the ads console's 97 select call sites sets one. */
  width?: number | string
  /** force the in-popover search box; it otherwise appears past SEARCH_THRESHOLD options */
  searchable?: boolean
  searchPlaceholder?: string
}

/** Past this many options a picker gets a search box without being asked. */
const SEARCH_THRESHOLD = 7

/**
 * Plain single-select styled dropdown — the zero-native-control replacement
 * for the `Select` primitive (which styles a native `<select>` and still
 * opens the OS option list). Button trigger in the Select box skin + the
 * Combobox popover, no typeahead. Wave 1 gap-fill (2026-07-04): pages are
 * banned from native selects; this is what they migrate to.
 */
export function Listbox({ options, value, onChange, placeholder = 'Select…', ariaLabel, className, disabled,
  width, searchable, searchPlaceholder = 'Search…' }: ListboxProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  const selected = options.find((o) => o.value === value)
  // Ranked, separator-aware matching — a raw `includes` fails on names like "GALE | IT | Broad".
  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const matches = showSearch ? searchOptions(q, options, (o) => o.label) : options

  return (
    <div className={`nds-listbox${className ? ` ${className}` : ''}`} style={width != null ? { width } : undefined} ref={ref} onKeyDown={(e) => e.key === 'Escape' && (setOpen(false), setQ(''))}>
      <button type="button" className="nds-listbox-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}>
        <span className={selected ? undefined : 'ph'}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={15} className="chev" aria-hidden />
      </button>
      {open && (
        <div className="nds-combo-pop" role="listbox">
          {showSearch && (
            <div className="nds-combo-search">
              <Search size={13} aria-hidden />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label="Search options" />
            </div>
          )}
          {matches.length === 0 && <div className="nds-combo-empty">No matches</div>}
          {matches.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} disabled={o.disabled}
              className={o.value === value ? 'on' : undefined}
              onClick={() => { onChange(o.value); setOpen(false); setQ('') }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
