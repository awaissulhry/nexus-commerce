'use client'
import { useState } from 'react'
import { ChangeReview } from '../components/ChangeReview'
export function ChangeReviewExample() {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  return <section id="change-review-example"><h3>ChangeReview</h3>
    <p>Each field has an explicit choice, three labelled values, and a readable reason. Missing evidence remains visible.</p>
    <ChangeReview label="Example fields" selectedIds={selectedIds} onSelectionChange={setSelectedIds} items={[
      { id: 'title', label: 'Product title', status: 'Differs', note: 'Choose whether to replace the channel value.', selectable: true,
        values: [{ label: 'Nexus now', value: 'Summer jacket' }, { label: 'Last accepted', value: 'Unknown — no record' }, { label: 'Channel now', value: 'Light jacket' }] },
      { id: 'material', label: 'Material', status: 'Cannot compare', note: 'The channel read was unavailable.', selectable: false,
        values: [{ label: 'Nexus now', value: 'Cotton' }, { label: 'Last accepted', value: 'Unknown — no record' }, { label: 'Channel now', value: 'Unknown — read failed' }] },
    ]} />
  </section>
}
