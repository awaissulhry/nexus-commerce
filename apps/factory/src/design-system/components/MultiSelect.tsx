'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
  /** `sm` = the 28px bar tier (`--nds-control-h-sm`), for a toolbar or scope row. Default `md` = today. */
  size?: 'sm' | 'md'
  /** Trigger width; `'auto'` drops the 160px minimum so the trigger sizes to its label. */
  width?: number | 'auto'
  /** The fewest options that may stay selected (passed to `OptionList`). Default 0. */
  minSelected?: number
  /** The trigger's label for a selection, e.g. `v => 'Italian +2'`. Default "All" / "N selected". */
  formatLabel?: (value: string[]) => string
  /** id for the TRIGGER, so a `<label htmlFor>` reaches it. */
  id?: string
}

/**
 * Checkbox multi-select dropdown (H10 `.h10-ms`): "All" / "N selected" + Select-all.
 *
 * The TRIGGER, the label and the popover placement live here; the list inside the popover is
 * `OptionList`, shared with the grid's column-menu set filter so the two controls are the same
 * control and not two files that agree today. See `OptionList` for why.
 */
export function MultiSelect({ options, value, onChange, placeholder = 'All', className,
  ariaLabel, searchable, searchPlaceholder, size = 'md', width, minSelected = 0, formatLabel, id }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)

  const allChecked = value.length === options.length && options.length > 0
  const label = formatLabel && value.length > 0 ? formatLabel(value) : value.length === 0 ? placeholder : allChecked ? 'All' : `${value.length} selected`

  /**
   * Step 4.3 #2 (T1) — focus. The popover is portalled to `<body>`, so without this a keyboard user
   * opened it and stayed on the trigger, and Tab from the popover's last row left the page's order.
   * Open → the first control in the popover (its search box when shown, else the first option);
   * Esc → closed, focus back on the trigger; Tab past the last row (or Shift+Tab before the first)
   * → closed, focus back on the trigger, and Tab continues from there.
   */
  useEffect(() => {
    if (!open) return
    const pop = popRef.current
    if (pop && !pop.contains(document.activeElement)) pop.querySelector<HTMLElement>('input')?.focus()
  }, [open, popRef])
  const close = () => { setOpen(false); triggerRef.current?.focus() }
  const onPopKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const controls = [...(popRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])') ?? [])]
    const at = controls.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey ? at <= 0 : at === controls.length - 1) {
      if (e.shiftKey) e.preventDefault()
      close()
    }
  }

  return (
    <div className={['nds-ms', size === 'sm' ? 'sm' : '', width === 'auto' ? 'auto' : '', className].filter(Boolean).join(' ')}
      style={typeof width === 'number' ? { width } : undefined} ref={ref}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) close() }}>
      <button ref={triggerRef} type="button" id={id} className="nds-ms-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        <span className={value.length === 0 ? 'ph' : ''}>{label}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        createPortal(
          <div ref={popRef} style={popStyle} className="nds-ms-pop" role="listbox" aria-multiselectable="true" onKeyDown={onPopKeyDown}>
            <OptionList
              options={options}
              value={value}
              onChange={onChange}
              searchable={searchable}
              searchPlaceholder={searchPlaceholder}
              minSelected={minSelected}
            />
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
