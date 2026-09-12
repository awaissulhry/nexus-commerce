'use client'
import { useEffect, useRef } from 'react'
import { RecordListInput, type RecordListField } from '@/design-system/components'

export function parseRecordValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
export function recordSummary(value: unknown, fields: RecordListField[]): string {
  if (!Array.isArray(value)) return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return value.map(record => fields.map(field => {
    const item = record?.[field.key]
    return item == null ? '' : field.options?.find(option => option.value === item)?.label ?? String(item)
  }).filter(Boolean).join(' · ')).join('; ')
}
/** Uses the dictionary's record schema; no provider-specific editor or lossy string conversion. */
export function StructuredAttributeEditor({ value, onValueChange, attributeColumn }: {
  value: unknown; onValueChange: (value: unknown) => void
  attributeColumn: { label: string; validation?: Record<string, unknown> }
}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.querySelector<HTMLElement>('input, select, button')?.focus() }, [])
  const rows = Array.isArray(value) && value.every(item => item && typeof item === 'object' && !Array.isArray(item)) ? value : value == null ? [] : null
  return <div ref={root} className="nds-list-editor" style={{ width: 'min(620px, 85vw)', maxHeight: '65vh', overflow: 'auto' }}>
    {rows ? <RecordListInput label={attributeColumn.label} fields={attributeColumn.validation?.recordFields as RecordListField[]} value={rows}
      onChange={onValueChange} maxItems={typeof attributeColumn.validation?.maxItems === 'number' ? attributeColumn.validation.maxItems : undefined} />
      : <p role="alert">This saved value uses an older format. Review its correction preview before converting it into records; the current value is preserved.</p>}
  </div>
}
