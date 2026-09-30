'use client'
import { REFERENCE_FIELDS, type ReferenceField } from '@nexus/shared/reference-values'
import { useEffect, useState } from 'react'
import { AsyncListboxPanel } from '@/design-system/components'
import { cellValueOf, isUnchanged, typedStart, type EditorStop, type GridCancel } from '@/design-system/grid'
import { Button, Select } from '@/design-system/primitives'
import { loadEbayPolicies, policyLists, type Policy } from './ebayPolicies'

export const isEbayPolicyField = (key: string) => key in policyLists

export function EbayPolicyInput({ fieldKey, market, connectionId, value, disabled, onChange }: { fieldKey: string; market: string; connectionId?: string; value: unknown; disabled?: boolean; onChange: (value: string | null) => void }) {
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([fieldKey, market, connectionId, revision])
  const [result, setResult] = useState<{ key: string; options: Policy[]; error?: string } | null>(null)
  const loading = result?.key !== key
  const options = result?.key === key ? result.options : []
  const error = result?.key === key ? result.error : undefined
  useEffect(() => {
    let active = true
    void loadEbayPolicies(market, revision > 0, connectionId).then(data => { if (active) setResult({ key, options: data[policyLists[fieldKey]] ?? [] }) })
      .catch(error => { if (active) setResult({ key, options: [], error: error.message }) })
    return () => { active = false }
  }, [key, market, fieldKey, revision, connectionId])
  const current = value == null ? '' : String(value)
  return <div>
    <Select aria-label="eBay business policy" value={current} disabled={disabled || loading || !!error} onChange={event => onChange(event.target.value || null)}>
      <option value="">No policy selected</option>
      {current && !options.some(option => option.id === current) && <option value={current}>Current policy · {current}</option>}
      {options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </Select>
    {loading && <p role="status">Loading seller policies…</p>}
    {error && <p role="alert">{error}</p>}
    <Button size="xs" variant="ghost" disabled={loading || disabled} onClick={() => setRevision(value => value + 1)}>Refresh policies</Button>
  </div>
}

/**
 * The grid's policy cell: the same search-and-list panel as the category and reference cells, so Enter, Tab, the arrows,
 * typing and Escape work as they do there. It was a native select with no focus and no keys: arrows did nothing, a typed
 * letter did nothing and Tab left without a choice, so a policy could be set only with the mouse (audit B13).
 */
export function EbayPolicyEditor({ value, onValueChange, fieldKey, market, connectionId, stopEditing, api, eventKey }: {
  value: unknown; onValueChange: (value: unknown) => void; fieldKey: string; market: string; connectionId?: string; stopEditing: EditorStop; api: GridCancel; eventKey?: string | null
}) {
  // The key that opened the cell by typing starts the search; the grid consumed it.
  const [query, setQuery] = useState(() => typedStart(eventKey))
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([fieldKey, market, connectionId, revision])
  const [result, setResult] = useState<{ key: string; options: Policy[]; error?: string } | null>(null)
  useEffect(() => {
    let active = true
    void loadEbayPolicies(market, revision > 0, connectionId).then(data => { if (active) setResult({ key, options: data[policyLists[fieldKey]] ?? [] }) })
      .catch(error => { if (active) setResult({ key, options: [], error: error.message }) })
    return () => { active = false }
  }, [key, market, fieldKey, revision, connectionId])
  const loaded = result?.key === key ? result : null
  const current = value == null ? '' : String(value)
  const search = query.trim().toLowerCase()
  const changed = (chosen: string) => !isUnchanged(value, chosen)
  const label = REFERENCE_FIELDS[fieldKey as ReferenceField]?.label ?? 'Business policy'
  return <AsyncListboxPanel label={`Search ${label.toLowerCase()}`} query={query} onQueryChange={setQuery} value={current}
    loading={!loaded} error={loaded?.error}
    options={(loaded?.options ?? []).filter(option => `${option.name} ${option.id}`.toLowerCase().includes(search)).map(option => ({ value: option.id, label: option.name, title: `${option.name}\nID: ${option.id}` }))}
    currentLabel={current || undefined}
    onRetry={() => setRevision(revision => revision + 1)} onCancel={() => api.stopEditing(true)}
    onKeyChoice={(chosen, end) => { if (chosen !== null && changed(chosen)) onValueChange(cellValueOf(chosen)); if (end) stopEditing(false, end) }}
    onCommit={chosen => {
      if (!changed(chosen)) return api.stopEditing(true)
      onValueChange(cellValueOf(chosen)); stopEditing()
    }} style={{ width: 'min(480px, 85vw)' }} />
}
