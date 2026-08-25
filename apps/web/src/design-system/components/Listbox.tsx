'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'
import { groupOptions } from '../lib/group-options'
import { searchOptions } from '../lib/option-search'

export interface ListboxOption {
  value: string
  label: string
  disabled?: boolean
  /** native tooltip for this option; defaults to the label, which is how a truncated
   *  option stays readable (options are nowrap + ellipsis) */
  title?: string
  /**
   * Optional heading this option sits under. Options sharing a group render together, groups in
   * first-seen order.
   *
   * Exists because the rule builder's action picker is 26 actions across six `<optgroup>`s
   * ("Bids", "Budget", "Pause/resume"…) and flattening them loses the only structure that makes
   * the list navigable — so that one select stayed native rather than adopt the DS.
   */
  group?: string
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
  /**
   * Label for "nothing selected", which also renders a clear row at the top of the list — the
   * difference between a form select and a FILTER select. Skipped when the caller's own options
   * already contain a `value: ''` row, otherwise the list shows two clear rows and the caller's
   * label silently wins the closed-state lookup.
   */
  emptyLabel?: string
  /** render `emptyLabel` greyed — a placeholder ("Select a Portfolio") rather than a real
   *  default ("All"). Same distinction the ads filter bar has always drawn. */
  emptyIsPlaceholder?: boolean
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
  width, searchable, searchPlaceholder = 'Search…', emptyLabel, emptyIsPlaceholder = false }: ListboxProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)
  const selected = options.find((o) => o.value === value)
  // Ranked, separator-aware matching — a raw `includes` fails on names like "GALE | IT | Broad".
  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const ranked = showSearch ? searchOptions(q, options, (o) => o.label) : options
  // Group headings are visual, but they REORDER the list, and keyboard nav indexes a flat array.
  // `groupOptions` returns both halves together so they cannot drift apart — see its tests.
  const grouped = groupOptions(ranked)
  const groups = grouped?.groups ?? null
  const matches = grouped?.flat ?? ranked
  const hasOwnEmpty = options.some((o) => o.value === '')
  const showClear = emptyLabel != null && !hasOwnEmpty
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(''); setActive(0) }
  const renderOption = (o: ListboxOption, i: number) => (
    <button key={o.value} type="button" role="option" aria-selected={o.value === value} disabled={o.disabled}
      className={[o.value === value ? 'on' : '', showSearch && i === active ? 'active' : ''].filter(Boolean).join(' ') || undefined} title={o.title ?? o.label}
      onClick={() => pick(o.value)}>
      {o.label}
    </button>
  )

  return (
    <div className={`nds-listbox${className ? ` ${className}` : ''}`} style={width != null ? { width } : undefined} ref={ref} onKeyDown={(e) => (() => {
        if (!open) return
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ(''); setActive(0) }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
        else if (e.key === 'Enter') { const m = matches[active]; if (m) { e.preventDefault(); pick(m.value) } }
      })()}>
      <button type="button" className="nds-listbox-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}>
        <span className={selected == null && (emptyIsPlaceholder || emptyLabel == null) ? 'ph' : undefined}>{selected?.label ?? emptyLabel ?? placeholder}</span>
        <ChevronDown size={15} className="chev" aria-hidden />
      </button>
      {open && (
        createPortal(
          <div ref={popRef} style={popStyle} className="nds-combo-pop" role="listbox">
            {showSearch && (
              <div className="nds-combo-search">
                <Search size={13} aria-hidden />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label="Search options" />
              </div>
            )}
            {showClear && (
              <button type="button" role="option" aria-selected={!value} className={!value ? 'on' : undefined}
                onClick={() => pick('')}>
                {emptyLabel}
              </button>
            )}
            {matches.length === 0 && <div className="nds-combo-empty">No matches</div>}
            {groups
              ? (() => {
                  let i = -1
                  return groups.map((g) => (
                    <div className="nds-combo-group" role="group" aria-label={g.name || undefined} key={g.name}>
                      {g.name !== '' && (
                        <div className="nds-combo-grouphd" aria-hidden>
                          {g.name}
                        </div>
                      )}
                      {g.options.map((o) => {
                        i += 1
                        return renderOption(o, i)
                      })}
                    </div>
                  ))
                })()
              : matches.map((o, i) => renderOption(o, i))}
          </div>,
          document.body,
        )
      )}
    </div>
  )
}
