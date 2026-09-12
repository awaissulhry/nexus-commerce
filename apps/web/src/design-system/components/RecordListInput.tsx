'use client'

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button, Input, Select } from '../primitives'
import { Field } from './Field'

export interface RecordListField {
  key: string
  label: string
  kind: 'text' | 'number' | 'boolean' | 'select'
  required?: boolean
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
}
export interface RecordListInputProps {
  label: string
  fields: RecordListField[]
  value: Array<Record<string, unknown>>
  onChange: (value: Array<Record<string, unknown>>) => void
  disabled?: boolean
  maxItems?: number
}

/** Repeated typed records preserve field pairing and unrecognized saved properties. */
export function RecordListInput({ label, fields, value, onChange, disabled, maxItems }: RecordListInputProps) {
  const id = useId()
  const root = useRef<HTMLFieldSetElement>(null)
  const focus = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  useLayoutEffect(() => {
    if (focus.current === null) return
    const index = focus.current
    focus.current = null
    const records = root.current?.querySelectorAll<HTMLElement>('[data-record]')
    records?.[Math.min(index, records.length - 1)]?.querySelector<HTMLElement>('input, select')?.focus()
    if (!records?.length) root.current?.querySelector<HTMLButtonElement>('[data-add-record]')?.focus()
  }, [value.length])
  const edit = (index: number, field: string, next: unknown) => onChange(value.map((row, i) => i === index ? { ...row, [field]: next } : row))
  return <fieldset ref={root} disabled={disabled} className="nds-record-list">
    <legend>{label}</legend>
    {value.map((row, index) => <fieldset key={index} data-record className="nds-record-list-item">
      <legend>{label} {index + 1}</legend>
      <div className="nds-record-list-fields">
        {fields.map(field => <Field key={field.key} label={field.label} required={field.required} htmlFor={`${id}-${index}-${field.key}`}>
          {field.kind === 'select' || field.kind === 'boolean'
            ? <Select aria-required={field.required || undefined} id={`${id}-${index}-${field.key}`} value={row[field.key] == null ? '' : String(row[field.key])}
                onChange={event => edit(index, field.key, event.target.value === '' ? null : field.kind === 'boolean' ? event.target.value === 'true' : event.target.value)}>
                <option value="">Choose…</option>
                {(field.kind === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                {row[field.key] != null && field.kind === 'select' && !field.options?.some(option => option.value === row[field.key]) && <option value={String(row[field.key])}>{String(row[field.key])} · saved value</option>}
              </Select>
            : <Input aria-required={field.required || undefined} id={`${id}-${index}-${field.key}`} type={field.kind === 'number' ? 'number' : 'text'} step={field.kind === 'number' ? 'any' : undefined} min={field.min} max={field.max}
                value={row[field.key] == null ? '' : String(row[field.key])} onChange={event => edit(index, field.key, field.kind === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value)} />}
        </Field>)}
      </div>
      <Button size="sm" variant="ghost" aria-label={`Remove ${label} ${index + 1}`} onClick={() => {
        focus.current = index
        onChange(value.filter((_, i) => i !== index))
        setAnnouncement(`Removed ${label} ${index + 1}. ${value.length - 1} records remain.`)
      }}>Remove</Button>
    </fieldset>)}
    <Button data-add-record size="sm" disabled={maxItems != null && value.length >= maxItems} onClick={() => {
      focus.current = value.length
      onChange([...value, {}])
      setAnnouncement(`Added ${label} ${value.length + 1}.`)
    }}>Add {label.toLowerCase()}</Button>
    <span className="nds-vh" role="status" aria-live="polite">{announcement}</span>
  </fieldset>
}
