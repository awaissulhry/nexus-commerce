'use client'

import { useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { searchOptions } from '../lib/option-search'

/**
 * OptionList — the checkbox option list, declared ONCE.
 *
 * WHY THIS EXISTS
 * `MultiSelect` (the accordion's picker) and `GridSetFilter` (the same filter inside AG's column
 * menu) rendered this list TWICE: the same `nds-combo-search` box, the same `nds-ms-opt` rows, the
 * same `nds-combo-empty`, the same `searchOptions()` ranking — duplicated JSX, kept in step by
 * hand. `grid/theme/grid.css` states the promise the duplication was meant to keep: *"the list
 * reuses the MultiSelect option rows … so a filter in the header menu reads exactly like the same
 * filter in the accordion."* It reused the CSS CLASSES, not the component.
 *
 * The drift was already real when this was extracted (2026-08-31): `MultiSelect` had a Select-all
 * row and `GridSetFilter` did not, so the Brand filter in the accordion and the Brand filter in the
 * column menu — which that comment promises are the same control — behaved differently. A shared
 * class name keeps two files LOOKING the same while they diverge in behaviour, and no CSS-level
 * guard can see it.
 *
 * WHAT EACH SIDE KEEPS
 * This component owns the search box, the Select-all row, the option rows and the empty state.
 * The SHELL stays with the caller, because the two shells genuinely differ: `MultiSelect` scrolls
 * the whole popover (`.nds-ms-pop`), while the grid filter keeps its search box fixed above a
 * scrolling list (`.nds-ag-filter-list`) and adds a Clear footer. `listClassName` is that seam —
 * the caller names the scroll container, and everything inside it is identical by construction.
 *
 * THE SEARCH QUERY IS INTERNAL. Both callers unmount this component when their popup closes, so
 * the query resets on close without either of them tracking it. `MultiSelect` previously cleared
 * it on Escape only, which meant a click-away left the next open pre-filtered.
 */
export interface OptionListItem {
  value: string
  label: ReactNode
}

export interface OptionListProps {
  options: OptionListItem[]
  value: string[]
  onChange: (next: string[]) => void
  /** Force the search box; it otherwise appears past `SEARCH_THRESHOLD` options. */
  searchable?: boolean
  searchPlaceholder?: string
  /** Class for the scroll container the rows live in — the caller owns the shell. */
  listClassName?: string
  /** The Select-all row. On by default: both callers want it, and that is the point. */
  selectAll?: boolean
  emptyLabel?: string
}

/** Past this many options a picker gets a search box without being asked. */
export const SEARCH_THRESHOLD = 7

export function OptionList({
  options,
  value,
  onChange,
  searchable,
  searchPlaceholder = 'Search…',
  listClassName,
  selectAll = true,
  emptyLabel = 'No matches',
}: OptionListProps) {
  const [q, setQ] = useState('')

  const allChecked = value.length === options.length && options.length > 0
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  // Select all deliberately applies to ALL options, not the filtered subset — a control labelled
  // "Select all" that silently selected a search result would be a lie.
  const toggleAll = () => onChange(allChecked ? [] : options.map((o) => o.value))

  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const matches = showSearch
    ? searchOptions(q, options, (o) => (typeof o.label === 'string' ? o.label : o.value))
    : options

  return (
    <>
      {showSearch && (
        <div className="nds-combo-search">
          <Search size={13} aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search options"
          />
        </div>
      )}
      <div className={listClassName}>
        {selectAll && (
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
        )}
        {matches.length === 0 && <div className="nds-combo-empty">{emptyLabel}</div>}
        {matches.map((o) => (
          <label key={o.value} className={['nds-ms-opt', value.includes(o.value) ? 'sel' : ''].filter(Boolean).join(' ')}>
            <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </>
  )
}
