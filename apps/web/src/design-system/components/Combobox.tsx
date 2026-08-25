'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'

export interface ComboboxOption {
  value: string
  label: string
}

export interface ComboboxProps {
  options: ComboboxOption[]
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

/** Single-select typeahead (H10 `.h10-combo`): filter-as-you-type + pick. */
export function Combobox({ options, value, onChange, placeholder = 'Search…', className }: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)

  const selected = options.find((o) => o.value === value)
  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className={`nds-combo${className ? ` ${className}` : ''}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <input
        className="nds-combo-in"
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
        createPortal(
          <div ref={popRef} style={popStyle} className="nds-combo-pop" role="listbox">
            {filtered.length === 0 ? (
              <div className="nds-combo-empty">No matches</div>
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
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
