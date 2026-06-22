'use client'

import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'

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
}

/** Checkbox multi-select dropdown (H10 `.h10-ms`): "All" / "N selected" + Select-all. */
export function MultiSelect({ options, value, onChange, placeholder = 'All' }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  const allChecked = value.length === options.length && options.length > 0
  const label = value.length === 0 ? placeholder : allChecked ? 'All' : `${value.length} selected`
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  const toggleAll = () => onChange(allChecked ? [] : options.map((o) => o.value))

  return (
    <div className="h10-ds-ms" ref={ref}>
      <button type="button" className="h10-ds-ms-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={value.length === 0 ? 'ph' : ''}>{label}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        <div className="h10-ds-ms-pop" role="listbox" aria-multiselectable="true">
          <label className="h10-ds-ms-opt all">
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
          {options.map((o) => (
            <label key={o.value} className={['h10-ds-ms-opt', value.includes(o.value) ? 'sel' : ''].filter(Boolean).join(' ')}>
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
