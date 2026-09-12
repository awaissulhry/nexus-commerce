'use client'

import { useEffect, useId, useState, type CSSProperties } from 'react'
import { Search } from 'lucide-react'
import { Button, Input } from '../primitives'
import { Field } from './Field'
import { ListboxPanel } from './ListboxPanel'
import type { ListboxOption } from './Listbox'
import { groupOptions } from '../lib/group-options'

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
  style?: CSSProperties
}

/** Search plus externally loaded choices. The caller owns fetching/filtering and popup placement. */
export function AsyncListboxPanel({ label, query, onQueryChange, options, value, loading, error, message, placeholder = 'Search by name', emptyMessage = 'No matches', onRetry, onCommit, onCancel, style }: AsyncListboxPanelProps) {
  const id = useId()
  const [active, setActive] = useState(0)
  const choices = loading || error ? [] : groupOptions(options)?.flat ?? options
  const matchKey = choices.map(option => `${option.value}:${!!option.disabled}`).join('\u0000')
  useEffect(() => {
    const current = !query ? choices.findIndex(option => option.value === value && !option.disabled) : -1
    setActive(current >= 0 ? current : Math.max(0, choices.findIndex(option => !option.disabled)))
    // Values/disabled state define the index space; labels can update without moving the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, query, value])
  const selected = choices[active]
  return <div className="nds-async-listbox" style={style} onKeyDownCapture={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (!(event.target instanceof HTMLInputElement)) return
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation()
      if (selected && !selected.disabled) onCommit(selected.value)
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
