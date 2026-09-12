'use client'
import { useEffect, useState } from 'react'
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

export function EbayPolicyEditor({ value, onValueChange, fieldKey, market, connectionId, stopEditing }: { value: unknown; onValueChange: (value: unknown) => void; fieldKey: string; market: string; connectionId?: string; stopEditing: (cancel?: boolean) => void }) {
  return <div className="nds-list-editor" style={{ width: 'min(480px, 85vw)' }} onKeyDownCapture={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stopEditing(true) }
  }}><EbayPolicyInput fieldKey={fieldKey} market={market} connectionId={connectionId} value={value} onChange={chosen => {
    if (chosen === (value == null ? null : String(value))) return stopEditing(true)
    onValueChange(chosen); stopEditing()
  }} /><Button size="sm" variant="ghost" style={{ alignSelf: 'flex-end' }} onClick={() => stopEditing(true)}>Cancel</Button></div>
}
