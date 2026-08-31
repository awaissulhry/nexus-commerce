'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'
import { OptionList, type OptionListItem } from './OptionList'

/** The list's item shape, aliased so this component and `OptionList` cannot drift apart. */
export type MultiSelectOption = OptionListItem

export interface MultiSelectProps {
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  /** label shown when nothing is selected (default "All") */
  placeholder?: string
  className?: string
  ariaLabel?: string
  /** force the in-popover search box; it otherwise appears past OptionList's threshold */
  searchable?: boolean
  searchPlaceholder?: string
}

/**
 * Checkbox multi-select dropdown (H10 `.h10-ms`): "All" / "N selected" + Select-all.
 *
 * The TRIGGER, the label and the popover placement live here; the list inside the popover is
 * `OptionList`, shared with the grid's column-menu set filter so the two controls are the same
 * control and not two files that agree today. See `OptionList` for why.
 */
export function MultiSelect({ options, value, onChange, placeholder = 'All', className,
  ariaLabel, searchable, searchPlaceholder }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)

  const allChecked = value.length === options.length && options.length > 0
  const label = value.length === 0 ? placeholder : allChecked ? 'All' : `${value.length} selected`

  return (
    <div className={`nds-ms${className ? ` ${className}` : ''}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="nds-ms-btn" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        <span className={value.length === 0 ? 'ph' : ''}>{label}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        createPortal(
          <div ref={popRef} style={popStyle} className="nds-ms-pop" role="listbox" aria-multiselectable="true">
            <OptionList
              options={options}
              value={value}
              onChange={onChange}
              searchable={searchable}
              searchPlaceholder={searchPlaceholder}
            />
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
