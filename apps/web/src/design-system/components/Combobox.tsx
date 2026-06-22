'use client'

import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'

export interface ComboboxOption {
  value: string
  label: string
}

export interface ComboboxProps {
  options: ComboboxOption[]
  value?: string
  onChange: (value: string) => void
  placeholder?: string
}

/** Single-select typeahead (H10 `.h10-combo`): filter-as-you-type + pick. */
export function Combobox({ options, value, onChange, placeholder = 'Search…' }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  const selected = options.find((o) => o.value === value)
  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="h10-ds-combo" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <input
        className="h10-ds-combo-in"
        value={open ? query : selected?.label ?? ''}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
      />
      <ChevronDown size={15} className="chev" aria-hidden />
      {open && (
        <div className="h10-ds-combo-pop" role="listbox">
          {filtered.length === 0 ? (
            <div className="h10-ds-combo-empty">No matches</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={o.value === value ? 'on' : undefined}
                onClick={() => {
                  onChange(o.value)
                  setQuery('')
                  setOpen(false)
                }}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
