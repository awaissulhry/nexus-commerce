'use client'

import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'

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
}

/**
 * Plain single-select styled dropdown — the zero-native-control replacement
 * for the `Select` primitive (which styles a native `<select>` and still
 * opens the OS option list). Button trigger in the Select box skin + the
 * Combobox popover, no typeahead. Wave 1 gap-fill (2026-07-04): pages are
 * banned from native selects; this is what they migrate to.
 */
export function Listbox({ options, value, onChange, placeholder = 'Select…', ariaLabel, className, disabled }: ListboxProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  const selected = options.find((o) => o.value === value)

  return (
    <div className={`h10-ds-listbox${className ? ` ${className}` : ''}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="h10-ds-listbox-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}>
        <span className={selected ? undefined : 'ph'}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={15} className="chev" aria-hidden />
      </button>
      {open && (
        <div className="h10-ds-combo-pop" role="listbox">
          {options.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} disabled={o.disabled}
              className={o.value === value ? 'on' : undefined}
              onClick={() => { onChange(o.value); setOpen(false) }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
