'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'
import { mergeLabels } from '../lib/labels'
import { COMBOBOX_LABELS, type ComboboxLabels } from './ComboboxLabels'

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
  /** id of the visible label that names the field (a filter field's label, 2026-10-26). The input is otherwise unnamed. */
  labelledBy?: string
  /** Its words in the person's language (B-W2b-04): empty text, "No matches". Default English; `placeholder` wins. */
  labels?: Partial<ComboboxLabels>
}

/** Single-select typeahead (H10 `.h10-combo`): filter-as-you-type + pick. */
export function Combobox({ options, value, onChange, placeholder, className, labelledBy, labels }: ComboboxProps) {
  const words = mergeLabels(COMBOBOX_LABELS, labels)
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
        aria-labelledby={labelledBy}
        value={open ? query : selected?.label ?? ''}
        placeholder={placeholder === undefined ? words.search : placeholder}
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
              <div className="nds-combo-empty">{words.noMatches}</div>
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
