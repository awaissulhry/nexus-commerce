'use client'
import { REFERENCE_FIELDS } from '@nexus/shared/reference-values'
import { useEffect, useState } from 'react'
import { AsyncListboxPanel } from '@/design-system/components'
import { cellValueOf, isUnchanged } from '@/design-system/grid/editors/selectPanelModel'
import { loadReferenceChoices, type ReferenceChoices, type ReferenceField, type ReferenceScope } from './referenceOptions'

export function ReferenceSelectEditor({ fieldKey, market, productType, connectionId, value, onValueChange, stopEditing }: ReferenceScope & {
  fieldKey: ReferenceField; value: unknown; onValueChange: (value: unknown) => void; stopEditing: (cancel?: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([fieldKey, market, productType, connectionId, revision])
  const [result, setResult] = useState<{ key: string; choices?: ReferenceChoices; error?: string } | null>(null)
  const current = result?.key === key ? result : null
  useEffect(() => {
    let active = true
    // Recheck active/default state on each open; names shown in cells may be cached.
    void loadReferenceChoices(fieldKey, { market, productType, connectionId }, true)
      .then(choices => { if (active) setResult({ key, choices }) })
      .catch(error => { if (active) setResult({ key, error: error.message }) })
    return () => { active = false }
  }, [key, fieldKey, market, productType, connectionId, revision])
  const choices = current?.choices
  const text = value == null ? '' : String(value)
  const missingCurrent = choices && text && !choices.options.some(option => option.value === text)
  return <AsyncListboxPanel label={`Search ${REFERENCE_FIELDS[fieldKey].label.toLowerCase()}`}
    query={query} onQueryChange={setQuery} value={text} loading={!current} error={current?.error}
    options={(choices?.options ?? []).filter(option => `${option.searchText ?? option.label}`.toLowerCase().includes(query.trim().toLowerCase()))}
    message={missingCurrent ? `The current selection (${choices.labels[text] ?? text}) is unavailable. Choose an available option to replace it.` : undefined}
    onRetry={() => setRevision(value => value + 1)} onCancel={() => stopEditing(true)}
    onCommit={chosen => {
      if (!choices?.options.some(option => option.value === chosen) || isUnchanged(value, chosen)) return stopEditing(true)
      onValueChange(cellValueOf(chosen)); stopEditing()
    }} style={{ width: 'min(480px, 85vw)' }} />
}
