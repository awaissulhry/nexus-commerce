'use client'

import { useEffect, useId, useState, type CSSProperties } from 'react'
import { Search } from 'lucide-react'
import { Button, Input } from '../primitives'
import { Field } from './Field'
import { ListboxPanel } from './ListboxPanel'
import type { ListboxOption } from './Listbox'
import { groupOptions } from '../lib/group-options'
import { searchTokens } from '../lib/option-search'

export interface AsyncListboxPanelProps {
  label: string
  query: string
  onQueryChange: (query: string) => void
  options: ListboxOption[]
  value?: string
  loading?: boolean
  error?: string
  message?: string
  placeholder?: string
  emptyMessage?: string
  onRetry?: () => void
  onCommit: (value: string) => void
  onCancel: () => void
  /**
   * Enter or Tab chose the highlighted choice, reported in the capture phase so a grid commits it and moves (Enter down,
   * Tab right), exactly as `ListboxPanel.onKeyChoice` does — `end` included. Enter with a search and nothing highlighted
   * (the choices are still loading) keeps the panel open. Absent, Enter commits here and Tab leaves, as they always did.
   */
  onKeyChoice?: (value: string | null, end?: KeyboardEvent) => void
  /** Names the stored value when the loaded choices do not include it ("Current: …"); absent, nothing is shown. */
  currentLabel?: string
  style?: CSSProperties
}

/** Search plus externally loaded choices. The caller owns fetching/filtering and popup placement. */
export function AsyncListboxPanel({ label, query, onQueryChange, options, value, loading, error, message, placeholder = 'Search by name', emptyMessage = 'No matches', onRetry, onCommit, onCancel, onKeyChoice, currentLabel, style }: AsyncListboxPanelProps) {
  const id = useId()
  const [active, setActive] = useState(-1)
  const choices = loading || error ? [] : groupOptions(options)?.flat ?? options
  const matchKey = choices.map(option => `${option.value}:${!!option.disabled}`).join('\u0000')
  /* Unsearched, the highlight is the stored value — or NOTHING when the loaded page does not hold it. It used to fall to the
     first choice, so opening Amazon's product types (the first 50 of 1,875, alphabetical) and pressing Enter replaced
     OUTERWEAR with 3D_PRINTABLE_DESIGNS and saved it (P0, 2026-09-30). */
  useEffect(() => {
    const current = choices.findIndex(option => option.value === value && !option.disabled)
    // A query with no search token ("-", "&") searches for nothing: the stored value keeps the highlight (audit B15).
    setActive(!searchTokens(query).length ? current : Math.max(0, choices.findIndex(option => !option.disabled)))
    // Values/disabled state define the index space; labels can update without moving the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, query, value])
  const selected = active >= 0 ? choices[active] : undefined
  const storedHidden = currentLabel !== undefined && !!value && !loading && !choices.some(option => option.value === value)
  return <div className="nds-async-listbox" style={style} onKeyDownCapture={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (event.key === 'Enter' && event.nativeEvent.isComposing) { event.stopPropagation(); return }
    if (event.key === 'Tab' && onKeyChoice) { onKeyChoice(selected && !selected.disabled ? selected.value : null); return }
    if (!(event.target instanceof HTMLInputElement)) return
    if (event.key === 'Enter' && onKeyChoice) {
      /* The grid ends Enter as it ends every other editor's, and moves down; this panel used to end it itself and the
         cell stayed (audit B10). */
      event.preventDefault()
      if (!selected && query) { event.stopPropagation(); return }
      const chosen = selected && !selected.disabled ? selected.value : null
      if (event.ctrlKey || event.metaKey) { event.stopPropagation(); onKeyChoice(chosen, event.nativeEvent) }
      else onKeyChoice(chosen)
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation()
      // Nothing highlighted = the operator has not chosen: keep the stored value.
      if (selected && !selected.disabled) onCommit(selected.value)
      else if (!query) onCancel()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActive(current => {
        for (let index = current + direction; index >= 0 && index < choices.length; index += direction) {
          if (!choices[index].disabled) return index
        }
        return current
      })
    }
  }}>
    <Field label={label}>
      <Input size="sm" autoFocus data-autofocus role="combobox" aria-autocomplete="list" aria-expanded={choices.length > 0}
        aria-controls={choices.length ? `${id}-listbox` : undefined}
        aria-activedescendant={selected && !selected.disabled ? `${id}-o${active}` : undefined}
        value={query} onChange={event => { setActive(0); onQueryChange(event.target.value) }}
        leadingIcon={<Search size={14} aria-hidden />} placeholder={placeholder} />
    </Field>
    {storedHidden && !query && <p role="status">Current: {currentLabel}</p>}
    {loading ? <p role="status">Loading choices…</p>
      : error ? <p role="alert">{error}</p>
      : choices.length ? <ListboxPanel idPrefix={id} optionTabIndex={-1} activeIndex={active} onActiveIndexChange={setActive}
        autoFocus={false} query="" options={choices} value={value} ariaLabel={label}
        style={{ width: '100%', maxWidth: '100%', maxHeight: 'min(280px, 40vh)', boxShadow: 'none' }}
        onCancel={onCancel} onCommit={chosen => { if (choices.some(option => option.value === chosen && !option.disabled)) onCommit(chosen) }} />
      : <p role="status">{emptyMessage}</p>}
    {message && !error && !loading && <p role="status">{message}</p>}
    <div className="nds-async-listbox-actions">
      {onRetry && <Button size="sm" variant="secondary" disabled={loading} onClick={onRetry}>{error ? 'Try again' : 'Refresh'}</Button>}
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  </div>
}
