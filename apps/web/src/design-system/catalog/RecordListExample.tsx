'use client'
import { useState } from 'react'
import { RecordListInput } from '../components/RecordListInput'
export function RecordListExample() {
  const [value, setValue] = useState<Array<Record<string, unknown>>>([{ material: 'cotton', percentage: 80 }, { material: 'polyester', percentage: 20 }])
  return <section id="record-list-example">
    <h3>RecordListInput</h3>
    <p>Each material stays paired with its percentage. Add and remove announce changes and return focus to a record. Unknown saved properties survive edits.</p>
    <RecordListInput label="Material" value={value} onChange={setValue} fields={[
      { key: 'material', label: 'Material', kind: 'select', required: true, options: [{ value: 'cotton', label: 'Cotton' }, { value: 'polyester', label: 'Polyester' }] },
      { key: 'percentage', label: 'Percentage', kind: 'number', required: true, min: 0, max: 100 },
    ]} />
    <output aria-label="Stored composition">{JSON.stringify(value)}</output>
  </section>
}
