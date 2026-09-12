'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@/design-system/primitives'

type Protector = { zone: string; standard: string; level: string }
const records = (value: unknown): Protector[] => Array.isArray(value) ? value.map(p => ({ zone: String(p?.zone ?? ''), standard: String(p?.standard ?? ''), level: String(p?.level ?? '') })) : []
export const protectorSummary = (value: unknown): string => records(value).map(p => [p.zone, p.standard, p.level].filter(Boolean).join(' · ')).join('; ')

/** Each protector remains one record; independent lists would lose zone/standard/level pairing. */
export function ImpactProtectorsInput({ value, disabled, onChange }: { value: unknown; disabled?: boolean; onChange: (value: Protector[]) => void }) {
  const [items, setItems] = useState(() => records(value))
  const stored = JSON.stringify(value)
  useEffect(() => { setItems(records(value)) }, [stored]) // eslint-disable-line react-hooks/exhaustive-deps
  const change = (next: Protector[]) => { setItems(next); onChange(next) }
  return <fieldset disabled={disabled} className="nds-grid-confirm-block">
    <legend className="nds-vh">Impact protectors</legend>
    {items.map((item, index) => <div key={index} className="nds-addvar-axes" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, .7fr)', alignItems: 'end' }}>
      {(['zone', 'standard', 'level'] as const).map(key => <label className="nds-addvar-field" key={key}>
        <span>{key.charAt(0).toUpperCase() + key.slice(1)}</span>
        <Input aria-label={`Protector ${index + 1} ${key}`} value={item[key]} onChange={event => change(items.map((p, i) => i === index ? { ...p, [key]: event.target.value } : p))} />
      </label>)}
      <Button size="xs" variant="ghost" style={{ gridColumn: '1 / -1', justifySelf: 'end' }} aria-label={`Remove protector ${index + 1}`} onClick={() => change(items.filter((_, i) => i !== index))}>Remove</Button>
    </div>)}
    <Button size="xs" variant="secondary" onClick={() => setItems([...items, { zone: '', standard: '', level: '' }])}>Add protector</Button>
  </fieldset>
}

export function ImpactProtectorsEditor({ value, onValueChange }: { value?: unknown; onValueChange: (value: unknown) => void }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.querySelector<HTMLElement>('input, button')?.focus() }, [])
  return <div ref={root} className="nds-list-editor" style={{ width: 'min(520px, 85vw)', maxHeight: '60vh', overflow: 'auto' }}>
    <ImpactProtectorsInput value={value} onChange={onValueChange} />
  </div>
}
