'use client'
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Select, Textarea } from '@/design-system/primitives'
import { OptionList } from '@/design-system/components'
import { asList, asMeasure } from '@/design-system/grid/renderers/shapeFormat'

type ShapeColumn = { label: string; shape?: string; options?: string[]; optionLabels?: Record<string, string>; mode?: string; unitOptions?: string[]; cardinality?: { max: number | null }; maxLength?: number | null }

/** Drawer controls preserve the same array/object values as the sheet's shape editors. */
export function AttributeShapeInput({ column, value, disabled, onChange }: { column: ShapeColumn; value: unknown; disabled?: boolean; onChange: (value: unknown) => void }) {
  const [items, setItems] = useState(() => asList(value))
  const [measure, setMeasure] = useState(() => asMeasure(value))
  const stamp = JSON.stringify(value)
  useEffect(() => { setItems(asList(value)); setMeasure(asMeasure(value)) }, [stamp]) // eslint-disable-line react-hooks/exhaustive-deps
  if (column.shape === 'measure') {
    const change = (next: typeof measure) => {
      setMeasure(next)
      if (next.value !== null && column.unitOptions?.length && !next.unit) return
      onChange(next.value === null && !next.unit ? null : next)
    }
    return <fieldset disabled={disabled} className="nds-addvar-axes">
      <legend className="nds-vh">{column.label}</legend>
      <label className="nds-addvar-field"><span>Value</span><Input aria-label={`${column.label} value`} type="number" step="any" value={measure.value ?? ''} onChange={e => change({ ...measure, value: e.target.value === '' ? null : Number(e.target.value) })} /></label>
      <label className="nds-addvar-field"><span>Unit</span><Select aria-label={`${column.label} unit`} value={measure.unit ?? ''} onChange={e => change({ ...measure, unit: e.target.value || null })}>
        <option value="">Select unit</option>
        {measure.unit && !column.unitOptions?.includes(measure.unit) && <option value={measure.unit}>{measure.unit}</option>}
        {column.unitOptions?.map(unit => <option key={unit} value={unit}>{unit}</option>)}
      </Select></label>
    </fieldset>
  }
  const change = (next: string[]) => { setItems(next); onChange(next) }
  if (column.mode === 'strict' && column.options?.length) return <fieldset disabled={disabled}>
    <legend className="nds-vh">{column.label}</legend>
    <OptionList options={column.options.map(option => ({ value: option, label: column.optionLabels?.[option] ?? option }))} value={items} onChange={change} searchable selectAll={false} />
  </fieldset>
  return <fieldset disabled={disabled} className="nds-grid-confirm-block">
    <legend className="nds-vh">{column.label}</legend>
    {items.map((item, index) => <div key={index} className="nds-addvar-field">
      <label><span>Value {index + 1}</span><Textarea aria-label={`${column.label} value ${index + 1}`} rows={2} style={{ minHeight: 64 }} value={item} maxLength={column.maxLength ?? undefined} onChange={e => change(items.map((old, i) => i === index ? e.target.value : old))} /></label>
      <Button size="xs" variant="ghost" style={{ alignSelf: 'end', justifySelf: 'end' }} aria-label={`Remove ${column.label} value ${index + 1}`} onClick={() => change(items.filter((_, i) => i !== index))}>Remove</Button>
    </div>)}
    <Button size="xs" variant="secondary" disabled={column.cardinality?.max != null && items.length >= column.cardinality.max} onClick={() => setItems([...items, ''])}>Add value</Button>
  </fieldset>
}

export function AttributeShapeEditor({ attributeColumn, value, onValueChange }: { attributeColumn: ShapeColumn; value: unknown; onValueChange: (value: unknown) => void }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.querySelector<HTMLElement>('textarea, input, button')?.focus() }, [])
  return <div ref={root} className="nds-list-editor" style={{ width: 'min(520px, 85vw)', maxHeight: '65vh', overflow: 'auto' }}>
    <AttributeShapeInput column={attributeColumn} value={value} onChange={onValueChange} />
  </div>
}
